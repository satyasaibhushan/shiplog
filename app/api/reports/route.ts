import { ownerSession } from "../../../src/hosted/auth";
import { productionStore } from "../../../src/hosted/database";
import { reportsRequest } from "../../../src/hosted/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return reportsRequest(request, await ownerSession(), productionStore, process.env.APP_URL);
}
export const POST = GET;
