// fork-only: offline is on by default, PI_OFFLINE=0/false/no opts out

export function applyOfflineDefault(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
	if (args.includes("--offline")) return true;
	const value = env.PI_OFFLINE?.toLowerCase();
	if (value !== "0" && value !== "false" && value !== "no") return true;
	// downstream treats any set PI_OFFLINE as offline, so a leftover "0" must be removed
	delete env.PI_OFFLINE;
	return false;
}
