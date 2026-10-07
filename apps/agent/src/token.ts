/** O token vem de --token ou, se faltar, de GLOBAL_AGENTS_TOKEN (evita deixá-lo no histórico do shell). */
export function resolveToken(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (flag !== undefined) return flag;
  const e = env["GLOBAL_AGENTS_TOKEN"];
  return e !== undefined && e !== "" ? e : undefined;
}
