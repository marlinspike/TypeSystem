#!/usr/bin/env node
import { engineerCommand } from "./cli.js";

process.exitCode = await engineerCommand(process.argv.slice(2));
