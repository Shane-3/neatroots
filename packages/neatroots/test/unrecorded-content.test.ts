import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import type { OtlpSpan } from "../src/otlp/types.js";
import { batch, hex, s, span, tmpHome, toolSpan } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const lib = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];
const check = (id: string) => lib.find((c) => c.id === id)!;

function evaluate(id: string, spans: (traceId: string, root: string) => OtlpSpan[]) {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  try {
    const t = hex(16);
    st.ingest([batch(spans(t, hex(8)))]);
    return evaluateRule(check(id), loadTrace(st, t), false);
  } finally {
    st.close();
  }
}

/** An OpenTelemetry GenAI tool span, with whatever content attributes the framework set (none when capture is off). */
function genaiTool(traceId: string, parent: string, tool: string, content: Record<string, string> = {}): OtlpSpan {
  const o = span({ traceId, parent, name: `execute_tool ${tool}`, kind: "unused", status: 0 });
  o.attributes = [s("gen_ai.operation.name", "execute_tool"), s("gen_ai.tool.name", tool), s("gen_ai.tool.call.id", hex(6)), ...Object.entries(content).map(([k, v]) => s(k, v))];
  return o;
}

describe("repeated-tool-call with content that wasn't recorded", () => {
  it("does not fire on calls that recorded no arguments or results (GenAI content capture off)", () => {
    expect(evaluate("repeated-tool-call", (t, root) => [1, 2, 3].map(() => genaiTool(t, root, "search")))).toBeNull();
  });

  it("does not fire when the arguments are in attributes neatroots doesn't read", () => {
    // Google ADK keeps them in gcp.vertex.agent.*: three different cities, not one call three times.
    expect(
      evaluate("repeated-tool-call", (t, root) =>
        ["Paris", "Oslo", "Lima"].map((city) => genaiTool(t, root, "get_weather", { "gcp.vertex.agent.tool_call_args": `{"city":"${city}"}`, "gcp.vertex.agent.tool_response": '{"status":"ok"}' })),
      ),
    ).toBeNull();
  });

  it("does not fire when only the results were recorded", () => {
    expect(evaluate("repeated-tool-call", (t, root) => [1, 2, 3].map(() => genaiTool(t, root, "search", { "gen_ai.tool.call.result": '{"hits":0}' })))).toBeNull();
  });

  it("still fires on a tool with no arguments called the same way three times", () => {
    expect(evaluate("repeated-tool-call", (t, root) => [1, 2, 3].map(() => toolSpan(t, root, "get_time", "{}", '"12:00"')))?.firing).toBe(true);
  });

  it("still fires on a tool that returned nothing, called with the same arguments three times", () => {
    expect(evaluate("repeated-tool-call", (t, root) => [1, 2, 3].map(() => toolSpan(t, root, "send_email", '{"to":"a@b.c"}')))?.firing).toBe(true);
  });
});

describe("tool-cycle with content that wasn't recorded", () => {
  it("does not fire on alternating calls whose results were never recorded", () => {
    expect(evaluate("tool-cycle", (t, root) => Array.from({ length: 8 }, (_, i) => genaiTool(t, root, i % 2 ? "fetch" : "search")))).toBeNull();
  });

  it("still fires when the alternating calls keep recording the same results", () => {
    const hit = evaluate("tool-cycle", (t, root) => Array.from({ length: 8 }, (_, i) => toolSpan(t, root, i % 2 ? "fetch" : "search", `{"page":${i}}`, '{"rows":[]}')));
    expect(hit?.firing).toBe(true);
    expect(hit?.params.pattern).toBe("search -> fetch");
  });
});
