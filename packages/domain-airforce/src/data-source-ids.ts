/**
 * Pulled out of `types/aircraft.ts` so a computed property binding
 * (`computed/needs-attention.ts`) can import a data source id without
 * creating a circular import — `aircraft.ts` needs to import that binding
 * for `x-computed`/`computedImplementations`, so the binding can't import
 * anything back from `aircraft.ts` itself. Re-exported from `aircraft.ts`
 * unchanged, so every existing `import { AIRCRAFT_DATA_SOURCE_ID } from
 * "./aircraft.js"` (or from the package root) keeps working.
 */
export const AIRCRAFT_DATA_SOURCE_ID = "in-memory-airforce-repo";
export const MAINTENANCE_DATA_SOURCE_ID = "mock-remis-rest";
