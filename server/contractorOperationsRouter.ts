import { TRPCError } from "@trpc/server";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { roleProcedure, router } from "./_core/trpc";
import { resolveActingScope } from "./_core/actingScope";
import { commercialJobChains, contractorBusinessProfiles, jobCrewAssignments, organizationRelationships, organizationWorkers, privateRateSchedules } from "../drizzle/schema";

const dbOrThrow = async () => { const db = await getDb(); if (!db) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"Database unavailable"}); return db; };
const ref = (p:string) => `${p}-${crypto.randomUUID()}`;
const relationshipType = z.enum(["PRIME_CONTRACTOR","CONTRACTOR","SUBCONTRACTOR","VENDOR","LEASED_OWNER_OPERATOR","INDEPENDENT_CARRIER","EQUIPMENT_PROVIDER"]);
const workerType = z.enum(["OWNER_DRIVER","EMPLOYEE_DRIVER","CO_DRIVER","SWAMPER","LABORER","EQUIPMENT_OPERATOR","HELPER","SHOP_HAND","MECHANIC","MAINTENANCE_SUPERVISOR","BOOKKEEPER","DISPATCHER","SAFETY_COMPLIANCE","OFFICE_ADMIN"]);
const compensationType = z.enum(["HOURLY","SALARY","DAY_RATE","LOAD_RATE","KM_RATE","PERCENTAGE","PIECE_RATE","CONTRACT_RATE"]);

export const contractorOperationsRouter = router({
  profileUpsert: roleProcedure("contractor.write").input(z.object({ operatingMode:z.enum(["LEASED_OWNER_OPERATOR","INDEPENDENT_CONTRACTOR","INDEPENDENT_CARRIER","CONTRACTOR_COMPANY"]), legalName:z.string().min(1).max(220), carrierNumber:z.string().max(80).nullable().optional() })).mutation(async ({ctx,input})=>{
    const db=await dbOrThrow(), orgRef=(await resolveActingScope(db,ctx.user.id)).tenantId;
    await db.insert(contractorBusinessProfiles).values({orgRef,...input,carrierNumber:input.carrierNumber??null,createdByUserId:ctx.user.id}).onDuplicateKeyUpdate({set:{operatingMode:input.operatingMode,legalName:input.legalName,carrierNumber:input.carrierNumber??null,status:"active"}}); return {orgRef};
  }),
  relationshipCreate: roleProcedure("contractor.write").input(z.object({childOrgRef:z.string().min(1).max(40),relationshipType,effectiveFrom:z.coerce.date()})).mutation(async({ctx,input})=>{
    const db=await dbOrThrow(), parentOrgRef=(await resolveActingScope(db,ctx.user.id)).tenantId; if(parentOrgRef===input.childOrgRef) throw new TRPCError({code:"BAD_REQUEST",message:"An organization cannot contract with itself."});
    const relationshipRef=ref("REL"); await db.insert(organizationRelationships).values({relationshipRef,parentOrgRef,childOrgRef:input.childOrgRef,relationshipType:input.relationshipType,status:"pending",effectiveFrom:input.effectiveFrom,createdByUserId:ctx.user.id}); return {relationshipRef,status:"pending" as const};
  }),
  relationships: roleProcedure("contractor.read").query(async({ctx})=>{ const db=await dbOrThrow(), org=(await resolveActingScope(db,ctx.user.id)).tenantId; return db.select().from(organizationRelationships).where(or(eq(organizationRelationships.parentOrgRef,org),eq(organizationRelationships.childOrgRef,org))); }),
  workerAdd: roleProcedure("contractor.write").input(z.object({userId:z.number().int().positive().nullable().optional(),operatorId:z.number().int().positive().nullable().optional(),workerType,compensationType:compensationType.nullable().optional(),effectiveFrom:z.coerce.date()})).mutation(async({ctx,input})=>{
    const db=await dbOrThrow(), orgRef=(await resolveActingScope(db,ctx.user.id)).tenantId, workerRef=ref("WRK"); await db.insert(organizationWorkers).values({workerRef,orgRef,...input,userId:input.userId??null,operatorId:input.operatorId??null,compensationType:input.compensationType??null,createdByUserId:ctx.user.id}); return {workerRef};
  }),
  crewAssign: roleProcedure("dispatch.assign").input(z.object({chainRef:z.string().min(1).max(80),unitId:z.number().int().positive(),primaryDriverWorkerRef:z.string().min(1).max(64),coDriverWorkerRef:z.string().min(1).max(64).nullable().optional(),additionalCrew:z.array(z.object({workerRef:z.string().min(1).max(64),role:workerType})).default([]),startsAt:z.coerce.date()})).mutation(async({ctx,input})=>{
    const db=await dbOrThrow(), org=(await resolveActingScope(db,ctx.user.id)).tenantId; const [chain]=await db.select().from(commercialJobChains).where(eq(commercialJobChains.chainRef,input.chainRef)).limit(1); if(!chain || (chain.assigningOrgRef!==org && chain.performingOrgRef!==org)) throw new TRPCError({code:"FORBIDDEN",message:"Job chain is outside the acting organization."}); if(input.coDriverWorkerRef===input.primaryDriverWorkerRef) throw new TRPCError({code:"BAD_REQUEST",message:"Primary driver and co-driver must be different workers."});
    const assignmentRef=ref("CREW"); await db.insert(jobCrewAssignments).values({assignmentRef,chainRef:input.chainRef,unitId:input.unitId,primaryDriverWorkerRef:input.primaryDriverWorkerRef,coDriverWorkerRef:input.coDriverWorkerRef??null,additionalCrewJson:JSON.stringify(input.additionalCrew),startsAt:input.startsAt,createdByUserId:ctx.user.id}); return {assignmentRef,hosLedgerPolicy:"INDIVIDUAL_PER_DRIVER" as const};
  }),
  jobChainCreate: roleProcedure("contractor.write").input(z.object({rootJobId:z.number().int().positive(),performingOrgRef:z.string().min(1).max(40),parentChainRef:z.string().max(80).nullable().optional(),customerOrgRef:z.string().max(40).nullable().optional(),operatingCarrierOrgRef:z.string().max(40).nullable().optional(),equipmentOwnerOrgRef:z.string().max(40).nullable().optional(),relationshipType:z.enum(["EMPLOYEE","LEASED_OWNER_OPERATOR","INDEPENDENT_CONTRACTOR","SUBCONTRACTOR","INDEPENDENT_CARRIER"])})).mutation(async({ctx,input})=>{
    const db=await dbOrThrow(), assigningOrgRef=(await resolveActingScope(db,ctx.user.id)).tenantId; if(input.parentChainRef){const [p]=await db.select().from(commercialJobChains).where(eq(commercialJobChains.chainRef,input.parentChainRef)).limit(1); if(!p || p.performingOrgRef!==assigningOrgRef) throw new TRPCError({code:"FORBIDDEN",message:"Only the performing organization may subcontract its assignment."});}
    const chainRef=ref(input.parentChainRef?"SUB":"JOB"); await db.insert(commercialJobChains).values({chainRef,rootJobId:input.rootJobId,parentChainRef:input.parentChainRef??null,assigningOrgRef,performingOrgRef:input.performingOrgRef,customerOrgRef:input.customerOrgRef??null,operatingCarrierOrgRef:input.operatingCarrierOrgRef??null,equipmentOwnerOrgRef:input.equipmentOwnerOrgRef??null,relationshipType:input.relationshipType,createdByUserId:ctx.user.id}); return {chainRef};
  }),
  rateSet: roleProcedure("contractor.approve").input(z.object({counterpartyOrgRef:z.string().min(1).max(40),chainRef:z.string().max(80).nullable().optional(),compensationType,rateCents:z.number().int().nonnegative(),currency:z.string().length(3).default("CAD"),effectiveFrom:z.coerce.date()})).mutation(async({ctx,input})=>{
    const db=await dbOrThrow(), ownerOrgRef=(await resolveActingScope(db,ctx.user.id)).tenantId, rateRef=ref("RATE"); await db.insert(privateRateSchedules).values({rateRef,ownerOrgRef,...input,chainRef:input.chainRef??null,createdByUserId:ctx.user.id}); return {rateRef};
  }),
  ratesMine: roleProcedure("contractor.read").query(async({ctx})=>{const db=await dbOrThrow(),org=(await resolveActingScope(db,ctx.user.id)).tenantId; return db.select().from(privateRateSchedules).where(or(eq(privateRateSchedules.ownerOrgRef,org),eq(privateRateSchedules.counterpartyOrgRef,org)));}),
});
