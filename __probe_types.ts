import { appRouter } from "./server/routers";
type C = ReturnType<typeof appRouter.createCaller>;
type FR = C["fieldRoute"];
type A<T> = T extends (...a: any[]) => Promise<infer R> ? R : never;

// Print via deliberate errors: assign each to `never` and read tsc's message.
declare const evidenceAdd: A<FR["evidence"]["add"]>;
declare const docsCreate: A<FR["identity"]["documents"]["create"]>;
declare const loadsCreate: A<FR["compliance"]["loads"]["create"]>;
declare const maintCreate: A<FR["compliance"]["maintenance"]["create"]>;
declare const safetyCreate: A<FR["safety"]["create"]>;
declare const unitsCreate: A<FR["identity"]["units"]["create"]>;
declare const manifestsCreate: A<FR["manifests"]["create"]>;
declare const signCreate: A<FR["compliance"]["sign"]>;
declare const scansCreate: A<FR["scans"]["create"]>;
declare const dutyCreate: A<FR["dutyRecords"]["create"]>;
declare const breadcrumb: A<FR["gps"]["submitBreadcrumb"]>;
declare const routeDec: A<FR["routeDecisions"]["create"]>;
declare const routeCtx: A<FR["routeContext"]["create"]>;

const a1: never = evidenceAdd;
const a2: never = docsCreate;
const a3: never = loadsCreate;
const a4: never = maintCreate;
const a5: never = safetyCreate;
const a6: never = unitsCreate;
const a7: never = manifestsCreate;
const a8: never = signCreate;
const a9: never = scansCreate;
const a10: never = dutyCreate;
const a11: never = breadcrumb;
const a12: never = routeDec;
const a13: never = routeCtx;
