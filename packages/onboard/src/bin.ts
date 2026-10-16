#!/usr/bin/env node
import { onboardCommand } from "./command.js";

process.exitCode = await onboardCommand(process.argv.slice(2));
