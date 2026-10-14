import type { Page } from "playwright-core";
import { MISSION_SIGN_INS, MISSION_TOKENS } from "../src/index.js";

/**
 * One squadron readiness scenario, driven through a browser, that both
 * versions of the application must pass (ADR-0063). It reads only what a
 * person sees: the same `data-testid`s, labels and buttons in both clients.
 * What it observed is returned rather than asserted step by step, so a test
 * can compare the two versions against one expectation.
 */
export interface Observed {
  /** The board as the viewer and as the maintainer see it: its tail numbers, and AF90-0105's row in full. */
  readonly board: { readonly viewer: Board; readonly maintainer: Board };
  /** What the viewer sees and may do on AF90-0102. */
  readonly viewer: { readonly events: readonly string[]; readonly canOpen: boolean; readonly canUpdate: boolean; readonly groundRefused: boolean };
  /** The maintainer opens a work order for EVT-0102-2 and starts it. */
  readonly opened: { readonly assignedTo: string; readonly statusAfterOpen: string; readonly statusAfterUpdate: string };
  /** Whether the maintainer (not a lead) is offered a status change on TSgt Chen's WO-0002. */
  readonly maintainerCanUpdateOthers: boolean;
  /** The maintainer asks to ground AF90-0111; a lead approves. */
  readonly grounding: {
    readonly started: string;
    readonly initiatorSeesApproval: boolean;
    readonly leadSees: string;
    readonly approved: string;
    readonly workOrder: { readonly status: string; readonly assignedTo: string };
  };
  /** Whether the lead is offered a status change on WO-0002. */
  readonly leadCanUpdateOthers: boolean;
}

export interface Board {
  readonly tails: readonly string[];
  readonly af900105: readonly string[];
}

const label = (token: keyof typeof MISSION_TOKENS) => MISSION_SIGN_INS.find((s) => s.token === token)!.label;

export async function runScenario(page: Page, base: string): Promise<Observed> {
  // The screen has settled when no request has been in flight for a moment: Action listings and refreshes load after what triggered them.
  let inFlight = 0;
  page.on("request", () => inFlight++);
  page.on("requestfinished", () => inFlight--);
  page.on("requestfailed", () => inFlight--);
  const settled = async () => {
    for (let quiet = 0; quiet < 3; ) {
      await page.waitForTimeout(50);
      quiet = inFlight === 0 ? quiet + 1 : 0;
    }
  };
  await page.goto(base);

  const signInAs = async (token: keyof typeof MISSION_TOKENS) => {
    await page.getByRole("button", { name: label(token), exact: true }).click();
    await page.getByTestId("subject").filter({ hasText: MISSION_TOKENS[token]!.subjectId }).waitFor();
  };
  const board = async () => {
    const rows = page.getByTestId("board").locator("tbody tr");
    await rows.first().waitFor();
    return {
      tails: (await rows.locator("td:first-child").allTextContents()).map((t) => t.trim()),
      af900105: (await rows.filter({ hasText: "AF90-0105" }).locator("td").allTextContents()).map((t) => t.trim())
    };
  };
  const open = async (tail: string) => {
    await page.getByTestId("board").getByRole("button", { name: tail, exact: true }).click();
    await page.getByTestId("detail").getByRole("heading", { name: tail }).waitFor();
    await page.getByTestId("events").locator("li").first().waitFor();
  };
  const event = (id: string) => page.getByTestId(`event-${id}`);
  const order = (id: string) => page.getByTestId(`order-${id}`);
  /** Whether a control is there once the screen has settled. */
  const offered = async (where: ReturnType<Page["getByTestId"]>, role: "button" | "combobox", name: string) => {
    await settled();
    return (await where.getByRole(role, { name }).count()) > 0;
  };

  // The viewer: the board, an aircraft's history, and nothing they may change.
  await signInAs("mission-viewer-token");
  const viewerBoard = await board();
  await open("AF90-0102");
  const viewerEvents = (await Promise.all((await page.getByTestId("events").locator("li").all()).map((li) => li.getAttribute("data-testid")))).map((t) => (t ?? "").replace(/^event-/, ""));
  const viewerCanOpen = await offered(event("EVT-0102-2"), "button", "Open work order");
  const viewerCanUpdate = await offered(order("WO-0002"), "combobox", "Status of WO-0002");
  await page.getByRole("button", { name: "Ground for repair" }).click();
  const groundRefused = await page
    .getByTestId("detail")
    .getByRole("alert")
    .waitFor({ timeout: 5_000 })
    .then(() => true, () => false);

  // The maintainer: opens a work order, then starts it.
  await signInAs("mission-maintainer-token");
  const maintainerBoard = await board();
  await open("AF90-0102");
  await event("EVT-0102-2").getByRole("button", { name: "Open work order" }).click();
  const newOrder = event("EVT-0102-2").locator("div[data-testid^='order-']");
  await newOrder.waitFor();
  const newId = (await newOrder.getAttribute("data-testid"))!.replace(/^order-/, "");
  const statusAfterOpen = (await newOrder.getByTestId("order-status").textContent())!;
  const assignedTo = (await newOrder.locator(".muted").textContent())!;
  await newOrder.getByRole("combobox", { name: `Status of ${newId}` }).selectOption("in-progress");
  await newOrder.getByRole("button", { name: "Set status" }).click();
  await settled();
  const statusAfterUpdate = (await newOrder.getByTestId("order-status").textContent())!;
  const maintainerCanUpdateOthers = await offered(order("WO-0002"), "combobox", "Status of WO-0002");

  // The maintainer asks to ground AF90-0111, and cannot approve it themselves.
  await open("AF90-0111");
  await page.getByRole("button", { name: "Ground for repair" }).click();
  const started = (await page.getByTestId("run-status").textContent())!;
  await settled();
  const initiatorSeesApproval = (await page.getByTestId("approvals").count()) > 0;

  // The lead approves; the work order is opened and started as the maintainer asked.
  await signInAs("mission-lead-token");
  const approvals = page.getByTestId("approvals");
  await approvals.waitFor();
  const leadSees = (await approvals.locator(".row strong").first().textContent())!;
  await approvals.getByRole("button", { name: "Approve" }).first().click();
  const approved = (await page.getByTestId("approved").textContent())!;
  await open("AF90-0102");
  const leadCanUpdateOthers = await offered(order("WO-0002"), "combobox", "Status of WO-0002");
  await open("AF90-0111");
  const grounded = event("EVT-0111-1").locator("div[data-testid^='order-']");
  await grounded.waitFor();
  const workOrder = { status: (await grounded.getByTestId("order-status").textContent())!, assignedTo: (await grounded.locator(".muted").textContent())! };

  return {
    board: { viewer: viewerBoard, maintainer: maintainerBoard },
    viewer: { events: viewerEvents, canOpen: viewerCanOpen, canUpdate: viewerCanUpdate, groundRefused },
    opened: { assignedTo, statusAfterOpen, statusAfterUpdate },
    maintainerCanUpdateOthers,
    grounding: { started, initiatorSeesApproval, leadSees, approved, workOrder },
    leadCanUpdateOthers
  };
}

const NEEDING_ATTENTION = ["AF90-0102", "AF90-0103", "AF90-0105", "AF90-0107", "AF90-0109", "AF90-0110", "AF90-0111", "AF90-0114", "AF90-0115", "AF90-0117", "AF90-0119", "AF90-0121", "AF90-0122", "AF90-0123"];

/** What both versions must show: the airforce domain's policy, as each person meets it. */
export const EXPECTED: Observed = {
  board: {
    // The viewer may know which aircraft need attention, but not their readiness or where they are (CUI clearance, viewer role).
    viewer: { tails: NEEDING_ATTENTION, af900105: ["AF90-0105", "F-16C", "", ""] },
    maintainer: { tails: NEEDING_ATTENTION, af900105: ["AF90-0105", "F-16C", "NMC", "Home station"] }
  },
  viewer: { events: ["EVT-0102-2", "EVT-0102-1"], canOpen: false, canUpdate: false, groundRefused: true },
  opened: { assignedTo: "SSgt Rivera", statusAfterOpen: "open", statusAfterUpdate: "in-progress" },
  maintainerCanUpdateOthers: false,
  grounding: { started: "waiting-approval", initiatorSeesApproval: false, leadSees: "AF90-0111", approved: "AF90-0111: completed", workOrder: { status: "in-progress", assignedTo: "SSgt Rivera" } },
  leadCanUpdateOthers: true
};
