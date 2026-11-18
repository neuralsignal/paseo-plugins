import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PluginHandlerContext } from "@getpaseo/plugin/server";

import { parseFrontmatter } from "./resolve/frontmatter";
import { resolveClaudeSkills } from "./resolve/claude";
import { resolveCodexSkills } from "./resolve/codex";
import { resolveHermesSkills } from "./resolve/hermes";
import { selectReported, supportsCommands } from "./resolve/reported";
import type { ReportedSkill } from "./resolve/reported";
import type { OnShadowedSkill, SkillEntry } from "./resolve/skill-entry";

export interface SkillRoots {
  claudeHome: string;
  codexHome: string;
  agentsHome: string;
  adminSkillsDir: string;
  /** `$HERMES_HOME` or `~/.hermes`. */
  hermesHome: string;
}

/**
 * `~/.agents` has no environment override — Codex documents the literal path.
 * `/etc/codex/skills` is a constant for the same reason; on a machine without
 * one it reads as an absent directory, which is the normal case.
 */
export function defaultSkillRoots(env: NodeJS.ProcessEnv = process.env): SkillRoots {
  const home = os.homedir();
  return {
    claudeHome: path.join(home, ".claude"),
    codexHome: env.CODEX_HOME ?? path.join(home, ".codex"),
    agentsHome: path.join(home, ".agents"),
    adminSkillsDir: path.join(path.sep, "etc", "codex", "skills"),
    hermesHome: env.HERMES_HOME ?? path.join(home, ".hermes"),
  };
}

interface ResolvedAgent {
  provider: string;
  cwd: string;
  handle: unknown;
}

async function loadAgent(agentId: string, context: PluginHandlerContext): Promise<ResolvedAgent> {
  const handle = context.paseo.agents.ref(agentId);
  const refreshed = await handle.refresh();
  const agent = refreshed?.agent ?? handle.current();
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return { provider: agent.provider, cwd: agent.cwd, handle };
}

interface ReportedSkills {
  available: boolean;
  error: string | null;
  skills: ReportedSkill[];
  commands: ReportedSkill[];
}

const UNAVAILABLE: ReportedSkills = {
  available: false,
  error: null,
  skills: [],
  commands: [],
};

/**
 * Asks the live session what it can run. A failure here never fails the whole
 * list: filesystem discovery already succeeded, and losing it because the
 * session could not answer would be a worse outcome than a missing section. The
 * error travels with the section so the panel can say why it is empty.
 */
async function loadReportedSkills(
  agent: ResolvedAgent,
  discovered: SkillEntry[],
): Promise<ReportedSkills> {
  if (!supportsCommands(agent.handle)) return UNAVAILABLE;
  const discoveredNames = discovered.map((entry) => entry.name);
  try {
    const result = await agent.handle.commands();
    return {
      available: true,
      error: result.error,
      ...selectReported(result.commands, discoveredNames),
    };
  } catch (error) {
    return {
      available: true,
      error: error instanceof Error ? error.message : String(error),
      skills: [],
      commands: [],
    };
  }
}

async function resolveForAgent(
  agent: ResolvedAgent,
  roots: SkillRoots,
  onShadowed?: OnShadowedSkill,
): Promise<SkillEntry[]> {
  if (agent.provider === "claude") {
    return resolveClaudeSkills({ cwd: agent.cwd, claudeHome: roots.claudeHome }, onShadowed);
  }
  if (agent.provider === "codex") {
    return resolveCodexSkills(
      {
        cwd: agent.cwd,
        codexHome: roots.codexHome,
        agentsHome: roots.agentsHome,
        adminSkillsDir: roots.adminSkillsDir,
      },
      onShadowed,
    );
  }
  if (agent.provider === "hermes") {
    return resolveHermesSkills({ hermesHome: roots.hermesHome }, onShadowed);
  }
  return [];
}

/**
 * Claude, Codex, and Hermes have documented skill directories to walk. Every
 * other provider still reaches the panel through what its session reports.
 */
function scansSkillFiles(provider: string): boolean {
  return provider === "claude" || provider === "codex" || provider === "hermes";
}

export function createListSkillsHandler(roots: SkillRoots = defaultSkillRoots()) {
  return async (input: { agentId: string }, context: PluginHandlerContext) => {
    const agent = await loadAgent(input.agentId, context);
    const skills = await resolveForAgent(agent, roots);
    return {
      provider: agent.provider,
      scanned: scansSkillFiles(agent.provider),
      cwd: agent.cwd,
      skills,
      reported: await loadReportedSkills(agent, skills),
    };
  };
}

/**
 * Takes a skill id, never a path. Discovery runs again and the id is looked up
 * in its result, so the only readable files are ones discovery already found.
 */
export function createReadSkillHandler(roots: SkillRoots = defaultSkillRoots()) {
  return async (input: { agentId: string; skillId: string }, context: PluginHandlerContext) => {
    const agent = await loadAgent(input.agentId, context);
    const shadowed: SkillEntry[] = [];
    const skills = await resolveForAgent(agent, roots, (winner, copy) => {
      if (winner.id === input.skillId) shadowed.push(copy);
    });
    const skill = skills.find((entry) => entry.id === input.skillId);
    if (!skill) {
      throw new Error(`Skill not available: ${input.skillId}`);
    }
    const resolvedPath = await realpath(skill.path);
    const [raw, resolvedCopies] = await Promise.all([
      readFile(resolvedPath, "utf8"),
      Promise.all(
        shadowed.map(async ({ path, source }) => ({
          path,
          source,
          canonicalPath: await realpath(path).catch(() => null),
        })),
      ),
    ]);
    const seen = new Set([resolvedPath]);
    const otherCopies = resolvedCopies.flatMap(({ path, source, canonicalPath }) => {
      if (!canonicalPath || seen.has(canonicalPath)) return [];
      seen.add(canonicalPath);
      return [{ path, source }];
    });
    return {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      path: skill.path,
      resolvedPath,
      otherCopies,
      body: parseFrontmatter(raw).body,
    };
  };
}
