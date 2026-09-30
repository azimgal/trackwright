import { getAgent } from '../dist/agents/registry.js';
import { parseTicket } from '../dist/tickets/parser.js';
import { readFileSync } from 'node:fs';

const raw = readFileSync(process.argv[2], 'utf8');
const ticket = parseTicket(raw);
const agent = getAgent('planner');
console.log('=== SYSTEM PROMPT ===');
console.log(agent.buildSystemPrompt());
console.log('=== TASK PROMPT ===');
console.log(agent.buildTaskPrompt({ ticket, cwd: process.cwd() }));
