import { AsyncLocalStorage } from "node:async_hooks";
import semver from "semver";
import { InvalidInputError } from "./errors.js";

/**
 * A consumer's contract (ADR-0103): the Types an application or agent was
 * built against, each with the semver range of versions it accepts.
 * `{ "airforce.Aircraft": "^1.0.0" }` says: this consumer reads Aircraft as
 * version 1 described it, and a 2.0.0 Aircraft is not what it was written for.
 *
 * A request made under a contract fails closed (`ContractUnsatisfiedError`)
 * when it touches a contracted Type whose registered version is outside the
 * range, rather than answering with a shape the consumer does not expect.
 * Types the contract does not name are not checked: the consumer made no
 * claim about them.
 */
export type ConsumerContract = Readonly<Record<string, string>>;

/** One contracted Type the model does not satisfy. `version` is given only where the caller may see the Type. */
export interface ContractMismatch {
  readonly type: string;
  readonly range: string;
  /** The version registered, where the caller may see it; absent when the Type is unknown or not visible to the caller. */
  readonly version?: string;
}

/**
 * A request touched a Type its consumer's contract names at a version the
 * model no longer has (ADR-0103). The consumer must be rebuilt against the
 * model, or the deployment kept at a version it accepts. The message names
 * the Type and the range, never the version registered, which a caller who
 * may not read the Type must not learn from a refusal.
 */
export class ContractUnsatisfiedError extends Error {
  constructor(readonly mismatches: readonly ContractMismatch[]) {
    super(`The model does not satisfy this consumer's contract: ${mismatches.map((m) => `${m.type} ${m.range}`).join(", ")}`);
    this.name = "ContractUnsatisfiedError";
  }
}

const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const MAX_ENTRIES = 256;

/** Every problem with `contract`: a Type name that is not one, or a range semver does not parse. Empty means it is a contract. */
export function validateContract(contract: unknown, at = "contract"): string[] {
  if (typeof contract !== "object" || contract === null || Array.isArray(contract)) return [`${at}: must map Type names to semver ranges`];
  const entries = Object.entries(contract);
  const out: string[] = [];
  if (entries.length > MAX_ENTRIES) out.push(`${at}: names more than ${MAX_ENTRIES} Types`);
  for (const [type, range] of entries) {
    if (!TYPE_NAME.test(type)) out.push(`${at}: "${type.slice(0, 64)}" is not a qualified Type name`);
    if (typeof range !== "string" || range.trim() === "" || semver.validRange(range) === null) out.push(`${at}["${type.slice(0, 64)}"]: must be a semver range`);
  }
  return out;
}

/** Whether `version` is within `range` (pre-release versions only where the range names one, as semver decides). */
export function satisfiesRange(version: string, range: string): boolean {
  return semver.satisfies(version, range);
}

/**
 * Where `types` (what the model has, by name) fall outside `contract`. A
 * contracted Type missing from `types` is a mismatch with no version.
 */
export function contractMismatches(contract: ConsumerContract, types: ReadonlyMap<string, string> | Readonly<Record<string, string>>): ContractMismatch[] {
  const lookup = (n: string): string | undefined => {
    if (types instanceof Map) return (types as ReadonlyMap<string, string>).get(n);
    const record = types as Readonly<Record<string, string>>;
    return Object.hasOwn(record, n) ? record[n] : undefined;
  };
  const out: ContractMismatch[] = [];
  for (const [type, range] of Object.entries(contract).sort(([a], [b]) => a.localeCompare(b))) {
    const version = lookup(type);
    if (version === undefined) out.push({ type, range });
    else if (!satisfiesRange(version, range)) out.push({ type, range, version });
  }
  return out;
}

/**
 * The HTTP header a consumer sends its contract in: `TypeSystem-Contract`,
 * comma-separated `Type@range` entries, e.g.
 * `airforce.Aircraft@^1.0.0, airforce.WorkOrder@>=1.2.0 <2.0.0`.
 */
export const CONTRACT_HEADER = "typesystem-contract";

/** The header's value for `contract`. */
export function formatContractHeader(contract: ConsumerContract): string {
  return Object.entries(contract)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, range]) => `${type}@${range}`)
    .join(", ");
}

/** The contract a header carries. Throws `InvalidInputError` naming every problem; an absent or empty header is no contract. */
export function parseContractHeader(value: string | readonly string[] | undefined): ConsumerContract | undefined {
  const raw = Array.isArray(value) ? value.join(",") : (value as string | undefined);
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw.length > 16_384) throw new InvalidInputError("The TypeSystem-Contract header is too long");
  const contract: Record<string, string> = {};
  const problems: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const at = entry.indexOf("@");
    if (at <= 0) {
      problems.push(`"${entry.slice(0, 64)}" is not Type@range`);
      continue;
    }
    const type = entry.slice(0, at).trim();
    // Assigned as a key below, "__proto__" would set nothing and vanish unchecked.
    if (type === "__proto__") {
      problems.push(`"__proto__" is not a qualified Type name`);
      continue;
    }
    if (Object.hasOwn(contract, type)) problems.push(`${type.slice(0, 64)} is named twice`);
    contract[type] = entry.slice(at + 1).trim();
  }
  problems.push(...validateContract(contract, "TypeSystem-Contract"));
  if (problems.length > 0) throw new InvalidInputError(`Invalid TypeSystem-Contract header: ${problems.join("; ")}`);
  return Object.freeze(contract);
}

const contracts = new AsyncLocalStorage<ConsumerContract>();

/**
 * Runs `fn` with `contract` in force for every runtime call it makes,
 * however deep (ADR-0103): what the HTTP API, the MCP server and an
 * application server do per request. Throws `InvalidInputError` for a
 * contract that is not one. A nested call replaces the outer contract.
 */
export function runUnderContract<T>(contract: ConsumerContract | undefined, fn: () => T): T {
  if (contract === undefined) return fn();
  const problems = validateContract(contract);
  if (problems.length > 0) throw new InvalidInputError(`Invalid consumer contract: ${problems.join("; ")}`);
  return contracts.run(Object.freeze({ ...contract }), fn);
}

/** The contract in force for the current call, if any. */
export function currentContract(): ConsumerContract | undefined {
  return contracts.getStore();
}

/**
 * Throws `ContractUnsatisfiedError` when the contract in force names
 * `type.name` and `type.version` is outside its range. What the runtime
 * calls on every Type a request reads, queries or acts on.
 */
export function assertContract(type: { readonly name: string; readonly version: string }): void {
  const contract = contracts.getStore();
  if (!contract || !Object.hasOwn(contract, type.name)) return;
  const range = contract[type.name]!;
  if (!satisfiesRange(type.version, range)) throw new ContractUnsatisfiedError([{ type: type.name, range }]);
}
