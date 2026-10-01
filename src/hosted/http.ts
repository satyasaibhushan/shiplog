import { permitsOrigin } from "./access.ts";
import { prepareReport } from "./report.ts";
import { Conflict, type ReportStore } from "./store.ts";
const LIMIT = 1024 * 1024;
export const privateJSON = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
async function readBody(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw Error("Use application/json");
  if (Number(request.headers.get("content-length")) > LIMIT) throw Error("Snapshot limit is 1 MiB");
  const reader = request.body?.getReader();
  if (!reader) throw Error("Body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > LIMIT) {
      await reader.cancel();
      throw Error("Snapshot limit is 1 MiB");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function reportsRequest(
  request: Request,
  owner: string | undefined,
  getStore: () => ReportStore,
  appURL: string | undefined,
  id?: string,
) {
  if (!owner) return privateJSON({ error: "Sign in as the configured owner" }, 401);
  if (request.method === "POST") {
    if (!permitsOrigin(request, appURL))
      return privateJSON({ error: "Invalid request origin" }, 403);
    let report;
    try {
      report = prepareReport(await readBody(request), owner);
    } catch {
      return privateJSON(
        { error: "Invalid snapshot, calendar settings or request body (maximum 1 MiB)" },
        400,
      );
    }
    try {
      return privateJSON(await getStore().save(owner, report));
    } catch (e) {
      return privateJSON(
        {
          id: report.id,
          error:
            e instanceof Conflict
              ? e.message
              : "Report storage unavailable; retry after checking configuration",
        },
        e instanceof Conflict ? 409 : 503,
      );
    }
  }
  if (request.method !== "GET") return privateJSON({ error: "Method not allowed" }, 405);
  if (id && !/^[a-f0-9]{64}$/.test(id)) return privateJSON({ error: "Report not found" }, 404);
  const versionText = new URL(request.url).searchParams.get("revision");
  const version = versionText === null ? undefined : Number(versionText);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
    return privateJSON({ error: "Invalid version" }, 400);
  try {
    const result = id ? await getStore().read(owner, id, version) : await getStore().list(owner);
    return id && !result.length
      ? privateJSON({ error: "Report not found" }, 404)
      : privateJSON(result);
  } catch {
    return privateJSON({ error: "Report storage unavailable" }, 503);
  }
}
