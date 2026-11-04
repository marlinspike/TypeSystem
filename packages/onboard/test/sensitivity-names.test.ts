import { describe, expect, it } from "vitest";
import { sensitivityHints } from "../src/sources.js";

const category = (name: string) => sensitivityHints(name, undefined).map((h) => h.category);

/** The names a drafted deployment withholds from readers (ADR-0111; 5.0 pressure test, H2), and names it must not. */
describe("sensitive column names", () => {
  it.each([
    ["credit_card", "financial"],
    ["card_number", "financial"],
    ["cc_num", "financial"],
    ["bank_routing", "financial"],
    ["tax_id", "government-id"],
    ["national_id", "government-id"],
    ["nin", "government-id"],
    ["drivers_license", "government-id"],
    ["birthday", "date-of-birth"],
    ["surname", "personal-name"],
    ["given_name", "personal-name"],
    ["emailaddress", "contact"],
    ["phonenumber", "contact"],
    ["latitude", "location"],
    ["username", "personal"],
    ["private_key", "credential"],
    ["pwd", "credential"]
  ])("flags %s as %s", (name, expected) => {
    expect(category(name)).toContain(expected);
  });

  it.each(["credit_limit", "tax_amount", "total", "status", "region", "tier", "tracking", "placed_at", "customer_id", "order_id", "description", "pinned", "spin_count", "hashtag"])("does not flag %s", (name) => {
    expect(category(name)).toEqual([]);
  });
});
