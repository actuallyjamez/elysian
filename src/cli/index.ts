#!/usr/bin/env bun
/**
 * elysian CLI entry point
 */

import { defineCommand, runMain } from "citty";
import { buildCommand } from "./commands/build";
import { devCommand } from "./commands/dev";
import { initCommand } from "./commands/init";
import { generateIacCommand } from "./commands/generate-iac";
import { version } from "../core/version";

const main = defineCommand({
	meta: {
		name: "elysian",
		version,
		description: "Automatic Lambda bundler for Elysia with API Gateway integration",
	},
	subCommands: {
		build: buildCommand,
		dev: devCommand,
		init: initCommand,
		"generate-iac": generateIacCommand,
	},
});

runMain(main);
