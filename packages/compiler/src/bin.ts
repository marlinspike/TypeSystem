#!/usr/bin/env node
import { appCommand } from "./cli.js";

process.exitCode = await appCommand(process.argv.slice(2));
