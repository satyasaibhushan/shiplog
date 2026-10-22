// Stand-in for ModelBridge during demo capture: reports two ready providers so
// the web UI passes its prerequisite check. It never generates text; the demo
// summaries come from seed.ts.
const port = Number(process.env.MODELBRIDGE_STUB_PORT ?? 4142);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return Response.json({ ok: true });
    if (path === "/v1/providers") {
      return Response.json({
        providers: [
          {
            id: "claude-cli",
            name: "Claude CLI",
            available: true,
            authenticated: true,
            ready: true,
            detail: "Demo provider",
            models: ["sonnet", "opus"],
            structuredOutput: "validated",
          },
          {
            id: "codex-cli",
            name: "Codex CLI",
            available: true,
            authenticated: true,
            ready: true,
            detail: "Demo provider",
            models: ["gpt-5.5", "gpt-5.4-mini"],
            structuredOutput: "strict",
          },
        ],
      });
    }
    return Response.json({ error: { code: "demo", message: "Generation is disabled in the demo" } }, { status: 503 });
  },
});
console.log(`modelbridge demo stub on http://127.0.0.1:${port}`);
