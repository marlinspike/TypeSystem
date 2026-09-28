#!/usr/bin/env node
import { startHttpServer } from "./http-transport.js";

const port = Number(process.env.PORT ?? 3939);
await startHttpServer(port);
