#!/usr/bin/env node
import { evaluateCommand } from "./cli.js";

process.exitCode = await evaluateCommand(process.argv.slice(2));
