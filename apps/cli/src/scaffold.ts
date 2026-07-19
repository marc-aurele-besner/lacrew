/**
 * `lacrew scaffold` — generate a runnable crew project from a flow template.
 * Offline by default (runFlow + mock backend); set ORCH_URL to run the same
 * flow against a live orchestrator. Inside the monorepo the generated
 * package.json links @lacrew/flows via file:, elsewhere it pins the npm name
 * (publish pending — see README note it writes).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { flowTemplates, getFlowTemplate, type FlowTemplate } from "@lacrew/flows";

export interface ScaffoldInput {
  /** Template id, with or without the tpl- prefix. */
  template: string;
  /** Target directory (created); defaults to ./<template-name>. */
  dir?: string;
  /** Monorepo root when scaffolding inside the lacrew repo (file: links). */
  repoRoot?: string;
  cwd?: string;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
  template: FlowTemplate;
}

export function resolveTemplate(id: string): FlowTemplate | undefined {
  return getFlowTemplate(id) ?? getFlowTemplate(`tpl-${id}`);
}

export function listTemplateIds(): string[] {
  return flowTemplates.map((t) => t.id);
}

function flowsDependency(targetDir: string, repoRoot?: string): string {
  if (repoRoot && existsSync(join(repoRoot, "packages/flows/package.json"))) {
    const rel = relative(targetDir, join(repoRoot, "packages/flows"));
    return `file:${rel}`;
  }
  return "latest";
}

export function scaffoldTemplate(input: ScaffoldInput): ScaffoldResult {
  const template = resolveTemplate(input.template);
  if (!template) {
    throw new Error(
      `unknown_template:${input.template} (available: ${listTemplateIds().join(", ")})`,
    );
  }

  const cwd = input.cwd ?? process.cwd();
  const slug = template.definition.id;
  const dir = resolve(cwd, input.dir ?? slug);
  if (existsSync(join(dir, "package.json"))) {
    throw new Error(`target_not_empty:${dir}`);
  }
  mkdirSync(join(dir, "flows"), { recursive: true });

  const flowsDep = flowsDependency(dir, input.repoRoot);
  const pkg = {
    name: `crew-${slug}`,
    private: true,
    type: "module",
    scripts: { start: "tsx crew.ts" },
    dependencies: { "@lacrew/flows": flowsDep },
    devDependencies: { tsx: "^4.19.4", typescript: "^5.8.3" },
  };

  const crewTs = `/**
 * ${template.name} — scaffolded by \`lacrew scaffold ${template.id}\`.
 * Offline by default; set ORCH_URL (+ ORCH_TOKEN) to run against a live
 * orchestrator, where gate steps ride the real policy stack.
 */

import { readFileSync } from "node:fs";
import {
  createFlowsClient,
  createMockFlowBackend,
  runFlow,
  type FlowDefinition,
} from "@lacrew/flows";

const definition = JSON.parse(
  readFileSync(new URL("./flows/${slug}.json", import.meta.url), "utf8"),
) as FlowDefinition;

const orchUrl = process.env.ORCH_URL;

if (orchUrl) {
  const client = createFlowsClient({ baseUrl: orchUrl, token: process.env.ORCH_TOKEN });
  await client.save(definition);
  const run = await client.run(definition.id, { input: process.argv[2] });
  for (const step of run.steps) {
    console.log(\`[\${step.stepId}] \${step.status}\${step.verdict ? \` verdict=\${step.verdict}\` : ""}\`);
  }
  console.log(\`run \${run.runId}: \${run.status}\`);
} else {
  const run = await runFlow(definition, createMockFlowBackend(), {
    input: process.argv[2],
    onStep: (step) =>
      console.log(\`[\${step.stepId}] \${step.status}\${step.verdict ? \` verdict=\${step.verdict}\` : ""}\`),
  });
  console.log(\`run \${run.runId}: \${run.status} (mock backend — set ORCH_URL to go live)\`);
}
`;

  const envExample = `# Point at a live orchestrator to leave mock mode
# ORCH_URL=http://127.0.0.1:8788
# ORCH_TOKEN=
`;

  const readme = `# crew-${slug}

${template.description}

Scaffolded from the \`${template.id}\` flow template (\`lacrew scaffold\`).

## Run

\`\`\`bash
npm install   # or pnpm install
npm start     # offline: mock backend, full step trace
\`\`\`

Set \`ORCH_URL\` (and \`ORCH_TOKEN\` if the orchestrator requires it) to save and
run the flow on a live orchestrator instead — gate steps then go through
\`lacrew_propose_intent\`, so spends stay inside the org's policy stack.

Edit \`flows/${slug}.json\` to reshape the pipeline; the same JSON loads into the
cloud Flow Builder.
${flowsDep === "latest" ? "\n> Note: `@lacrew/flows` is not on npm yet — link it from a lacrew checkout (`file:../lacrew/packages/flows`) until it publishes.\n" : ""}`;

  const files: Array<[string, string]> = [
    ["package.json", `${JSON.stringify(pkg, null, 2)}\n`],
    ["crew.ts", crewTs],
    [`flows/${slug}.json`, `${JSON.stringify(template.definition, null, 2)}\n`],
    [".env.example", envExample],
    ["README.md", readme],
  ];
  for (const [name, content] of files) {
    writeFileSync(join(dir, name), content);
  }

  return { dir, files: files.map(([name]) => name), template };
}
