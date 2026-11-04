import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PolicyExpression } from "@typesys/core";
import { validateDeployment, type ConfigString, type Deployment, type IdentitySpec } from "./deployment.js";

/** What `promoteDeployment` is told about the shared deployment's identity provider and secrets (ADR-0118). */
export interface PromoteOptions {
  /** The provider's issuer: a URL, or the name of the environment variable that holds it (`OIDC_ISSUER`). */
  readonly issuer: string;
  /** The `aud` the provider puts in tokens for this server: a value, or an environment variable's name. */
  readonly audience: string;
  /** The server's public address, which MCP clients sign in for: a URL or an environment variable's name. */
  readonly resource?: string;
  /** Where the provider puts roles or groups. Default `roles`. */
  readonly rolesClaim?: string;
  /** The secret holding the state database's connection string. Default `TYPESYS_STATE_URL`. */
  readonly stateSecret?: string;
  /** The secret holding the audit signing key. Default `TYPESYS_AUDIT_SIGNING_KEY`. */
  readonly signingSecret?: string;
  /** The signing key's id. Default `audit-1`. */
  readonly keyId?: string;
  /** The public half of the signing key, PEM. */
  readonly publicKey: string;
}

/** Every `$secret` and `$env` a deployment names: what whoever runs it must provide. */
export interface DeploymentReferences {
  readonly secrets: readonly string[];
  readonly env: readonly string[];
}

/** Walks the document for references, wherever they are. */
export function referencesOf(deployment: Deployment): DeploymentReferences {
  const secrets = new Set<string>();
  const env = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const r = v as Record<string, unknown>;
      if (typeof r.$secret === "string") secrets.add(r.$secret);
      if (typeof r.$env === "string") env.add(r.$env);
      for (const k of Object.keys(r)) walk(r[k]);
    }
  };
  walk(deployment);
  return { secrets: [...secrets].sort(), env: [...env].sort() };
}

/** Every role a policy names. */
function policyRoles(e: PolicyExpression, out: Set<string>): void {
  if (typeof e === "string") return;
  if ("role" in e) e.role.forEach((r) => out.add(r));
  else if ("anyOf" in e) e.anyOf.forEach((x) => policyRoles(x, out));
  else if ("allOf" in e) e.allOf.forEach((x) => policyRoles(x, out));
}

/** The roles a deployment's policies and personas name, sorted. */
export function rolesOf(deployment: Deployment): string[] {
  const out = new Set<string>();
  for (const e of Object.values(deployment.policies)) policyRoles(e, out);
  for (const p of Object.values(deployment.personas ?? {})) p.roles.forEach((r) => out.add(r));
  return [...out].sort();
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** A value given on the command line: an environment variable's name becomes a reference, anything else is literal. */
const configOf = (v: string): ConfigString => (ENV_NAME.test(v) ? { $env: v } : v);

/**
 * A development deployment made shareable (ADR-0118): no longer a demo,
 * signed in through the organization's OpenID Connect provider with an
 * audience, its audit trail in Postgres with signed checkpoints, and a role
 * map listing every role its policies use, for the provider's group names
 * to be written in. Everything else (packs, sources, policies, personas,
 * consumers) is kept, so `typesys deploy check dev shared` compares only
 * what promoting changed, and `deploy test` still runs as the personas.
 */
export function promoteDeployment(dev: Deployment, opts: PromoteOptions): Deployment {
  const keyId = opts.keyId ?? "audit-1";
  const stateSecret = opts.stateSecret ?? "TYPESYS_STATE_URL";
  const roles = rolesOf(dev);
  const identity: IdentitySpec = {
    kind: "oidc",
    issuer: configOf(opts.issuer),
    audience: configOf(opts.audience),
    ...(opts.resource ? { resource: configOf(opts.resource) } : {}),
    rolesClaim: opts.rolesClaim ?? "roles",
    // Each role as itself: replace a key with the provider's group name. A value not listed grants nothing.
    roleMap: Object.fromEntries(roles.map((r) => [r, [r]]))
  };
  const { demo: _demo, ...rest } = dev;
  const previousAudit = dev.state?.audit;
  return {
    ...rest,
    description: `${dev.description ? `${dev.description} ` : ""}Shared: promoted from the development deployment by typesys deploy promote.`.trim(),
    state: {
      ...dev.state,
      audit: {
        kind: "postgres",
        url: previousAudit?.kind === "postgres" ? previousAudit.url : { $secret: stateSecret },
        signing: { keyId, key: { $secret: opts.signingSecret ?? "TYPESYS_AUDIT_SIGNING_KEY" } },
        verifyKeys: { ...(previousAudit?.verifyKeys ?? {}), [keyId]: opts.publicKey },
        ...(previousAudit?.kind === "postgres" && previousAudit.retainDays !== undefined ? { retainDays: previousAudit.retainDays } : {})
      },
      // Applications run workflows whose approvals must outlive a restart (ADR-0106).
      ...(dev.applications?.length && dev.state?.workflows?.kind !== "postgres" ? { workflows: { kind: "postgres" as const, url: { $secret: stateSecret } } } : {})
    },
    identity
  };
}

/** `<name>.deployment.json` → `<name>.shared.deployment.json`, beside it. */
export function sharedFileFor(file: string): string {
  const base = path.basename(file).replace(/\.deployment\.json$|\.json$/, "");
  return path.join(path.dirname(file), `${base}.shared.deployment.json`);
}

export const PROMOTE_USAGE = `  typesys deploy promote <dev.deployment.json> --issuer <url|ENV> --audience <aud|ENV>
                         [--resource <url|ENV>] [--roles-claim <claim>] [--key-id <id>]
                         [--state-secret <NAME>] [--signing-secret <NAME>] [--out <file>] [--force]
      Write a shared deployment beside a development one (ADR-0118): not a demo, signed in
      through your OpenID Connect provider (an ENV name becomes a reference to that variable),
      its audit trail in Postgres with signed checkpoints, and a roleMap listing every role its
      policies use, to put your provider's group names in. Makes the signing key: the private
      half in secrets/ beside it (git-ignored), the public half in the deployment. Prints the
      secrets to provide and what to run next.
`;

interface PromoteArgs {
  file?: string;
  issuer?: string;
  audience?: string;
  resource?: string;
  rolesClaim?: string;
  keyId?: string;
  stateSecret?: string;
  signingSecret?: string;
  out?: string;
  force: boolean;
}

function parsePromote(argv: readonly string[]): PromoteArgs {
  const out: PromoteArgs = { force: false };
  const flags: Record<string, keyof PromoteArgs> = {
    "--issuer": "issuer",
    "--audience": "audience",
    "--resource": "resource",
    "--roles-claim": "rolesClaim",
    "--key-id": "keyId",
    "--state-secret": "stateSecret",
    "--signing-secret": "signingSecret",
    "--out": "out"
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") out.force = true;
    else if (Object.hasOwn(flags, a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      (out as unknown as Record<string, string>)[flags[a]!] = v;
    } else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else if (out.file === undefined) out.file = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  return out;
}

/** `typesys deploy promote ...`: the exit code. */
export async function promoteCommand(argv: readonly string[], log: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  let args: PromoteArgs;
  try {
    args = parsePromote(argv);
  } catch (e) {
    err(`${(e as Error).message}\n\n${PROMOTE_USAGE}`);
    return 2;
  }
  if (!args.file || !args.issuer || !args.audience) {
    err(`typesys deploy promote needs a development deployment, --issuer and --audience\n\n${PROMOTE_USAGE}`);
    return 2;
  }
  for (const [flag, v] of [["--state-secret", args.stateSecret], ["--signing-secret", args.signingSecret]] as const)
    if (v !== undefined && !ENV_NAME.test(v)) {
      err(`${flag} names a secret, such as TYPESYS_STATE_URL: upper-case letters, digits and _`);
      return 2;
    }
  if (args.keyId !== undefined && !/^[A-Za-z0-9._-]+$/.test(args.keyId)) {
    err("--key-id: letters, digits, '.', '_' and '-'");
    return 2;
  }
  // A literal that looks like neither a URL nor a variable is most likely a typo for one.
  for (const [flag, v] of [["--issuer", args.issuer], ["--resource", args.resource]] as const)
    if (v !== undefined && !ENV_NAME.test(v) && !/^https?:\/\//.test(v)) {
      err(`${flag}: give a URL (https://...) or the name of the environment variable that holds it, not ${JSON.stringify(v)}`);
      return 2;
    }
  let dev: Deployment;
  try {
    dev = JSON.parse(await readFile(args.file, "utf8")) as Deployment;
  } catch (e) {
    err(`${args.file}: ${(e as Error).message}`);
    return 1;
  }
  const devProblems = validateDeployment(dev);
  if (devProblems.length > 0) {
    err(`${args.file} is not a valid deployment:\n${devProblems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }
  const out = args.out ?? sharedFileFor(args.file);
  const keyId = args.keyId ?? "audit-1";
  const secretsDir = path.join(path.dirname(out), "secrets");
  const privFile = path.join(secretsDir, `${keyId}.private.pem`);
  if (!args.force)
    for (const f of [out, privFile])
      if (existsSync(f)) {
        err(`${f} exists: pass --force to replace it (a new signing key does not verify checkpoints signed with the old one)`);
        return 1;
      }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const shared = promoteDeployment(dev, {
    issuer: args.issuer,
    audience: args.audience,
    ...(args.resource ? { resource: args.resource } : {}),
    ...(args.rolesClaim ? { rolesClaim: args.rolesClaim } : {}),
    ...(args.stateSecret ? { stateSecret: args.stateSecret } : {}),
    ...(args.signingSecret ? { signingSecret: args.signingSecret } : {}),
    keyId,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString()
  });
  await mkdir(secretsDir, { recursive: true });
  // Never committed: the directory ignores everything in it, itself included.
  if (!existsSync(path.join(secretsDir, ".gitignore"))) await writeFile(path.join(secretsDir, ".gitignore"), "*\n");
  await writeFile(privFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  await writeFile(out, `${JSON.stringify(shared, null, 2)}\n`);

  const refs = referencesOf(shared);
  const remaining = validateDeployment(shared);
  const roles = Object.keys((shared.identity as { roleMap?: Record<string, unknown> }).roleMap ?? {});
  const lines = [
    `Wrote ${out} and its audit signing key ${privFile} (git-ignored).`,
    "",
    `Roles its policies use: ${roles.join(", ") || "none"}. In identity.roleMap, replace each key with the name your`,
    `provider puts in the "${shared.identity.kind === "oidc" ? (shared.identity.rolesClaim ?? "roles") : "roles"}" claim for it (a group or app role); a value not listed grants nothing.`,
    "",
    "Secrets and settings to provide when it runs:",
    ...refs.secrets.map((s) => `  ${s}${s === (args.signingSecret ?? "TYPESYS_AUDIT_SIGNING_KEY") ? `  (the contents of ${privFile})` : ""}`),
    ...refs.env.map((e) => `  ${e}`),
    ...(remaining.length > 0 ? ["", "Still to change before it serves (deploy build says the same):", ...remaining.map((p) => `  - ${p}`)] : []),
    "",
    "Next:",
    `  npx typesys deploy check ${args.file} ${out}     what promoting changes`,
    `  npx typesys migrate ${out}                   create the audit tables`,
    `  npx typesys deploy package ${out} --target compose   files to run it`
  ];
  log(lines.join("\n"));
  return 0;
}
