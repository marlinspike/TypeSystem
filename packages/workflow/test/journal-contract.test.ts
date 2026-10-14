import { describe, expect, it } from "vitest";
import { InMemoryJournal, workflowJournalContract } from "../src/index.js";

workflowJournalContract("InMemoryJournal", async () => new InMemoryJournal(), { describe, it, expect });
