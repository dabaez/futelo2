#!/usr/bin/env node
'use strict';

/**
 * Futelo – Feature Request CLI
 * ─────────────────────────────
 * Interactive terminal tool for managing feature requests stored in
 * the Futelo SQLite database.  Run from the backend directory:
 *
 *   npm run cli
 *       (or: node src/cli.js)
 *
 * The script opens the same DB the server uses, so it can be run while
 * the server is running (WAL mode allows concurrent reads + writes).
 *
 * Controls:
 *   ↑ / ↓ or j / k  — navigate list
 *   d                — toggle request done ↔ pending
 *   x                — delete the selected request permanently
 *   n                — add a new request (as the system user 0)
 *   Tab              — switch view (Pendientes / Hechas)
 *   q or Ctrl+C      — quit
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const readline = require('readline');
const { db, stmts } = require('./db/database');

// ── Terminal helpers ──────────────────────────────────────────────────────────
const ESC   = '\x1b[';
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN  = '\x1b[36m';
const AMBER = '\x1b[33m';
const RED   = '\x1b[31m';

const clear     = () => process.stdout.write('\x1b[2J\x1b[H');
const moveTo    = (r, c) => process.stdout.write(`${ESC}${r};${c}H`);
const hideCursor = () => process.stdout.write('\x1b[?25l');
const showCursor = () => process.stdout.write('\x1b[?25h');
const write      = (s) => process.stdout.write(s);
const writeln    = (s = '') => write(s + '\n');

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function padEnd(str, len) {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - visible.length));
}

// ── Data helpers ─────────────────────────────────────────────────────────────
function getRequests() {
  return stmts.getFeatureRequests.all();
}

function markDone(id, done) {
  stmts.setFeatureRequestDone.run(done ? 1 : 0, id);
}

function addRequest(text) {
  stmts.insertFeatureRequest.run(0, text); // user 0 = system / CLI
}

function deleteRequest(id) {
  stmts.deleteFeatureRequest.run(id);
}

// ── Renderer ──────────────────────────────────────────────────────────────────
const WIDTH = Math.min(process.stdout.columns || 80, 100);

function renderHeader(view) {
  writeln(`${BOLD}${CYAN}╔${'═'.repeat(WIDTH - 2)}╗${RESET}`);
  const title   = '  💬 Futelo – Feature Requests  ';
  const viewStr = view === 'done' ? `${GREEN}✅  Hechas${RESET}` : `${AMBER}💡  Pendientes${RESET}`;
  const line    = `${BOLD}${CYAN}║${RESET}${BOLD} ${title}${RESET}${DIM}[Tab] cambiar vista  ${RESET}${viewStr}`;
  writeln(padEnd(line, WIDTH - 1) + `${BOLD}${CYAN}║${RESET}`);
  writeln(`${BOLD}${CYAN}╚${'═'.repeat(WIDTH - 2)}╝${RESET}`);
}

function renderControls() {
  writeln(`${DIM}  [↑/↓] navegar   [d] toggle hecho   [x] borrar   [n] nueva idea   [q] salir${RESET}`);
  writeln();
}

function renderList(items, cursor, view) {
  if (items.length === 0) {
    writeln(`  ${DIM}No hay ${view === 'done' ? 'solicitudes implementadas' : 'solicitudes pendientes'}.${RESET}`);
    return;
  }
  const cols   = WIDTH - 4;
  const textW  = cols - 8;  // leave room for vote count column

  items.forEach((item, i) => {
    const selected = i === cursor;
    const author   = item.first_name || item.username || 'sistema';
    const votes    = `${AMBER}🔥${item.votes}${RESET}`;
    const text     = truncate(item.text, textW);
    const prefix   = selected ? `${BOLD}${CYAN}▶ ${RESET}` : '  ';
    const doneTag  = item.done ? ` ${GREEN}[✓]${RESET}` : '';
    writeln(`${prefix}${selected ? BOLD : ''}${text}${doneTag}${RESET}`);
    const meta = `     ${DIM}por ${author}${RESET}  ${votes}`;
    writeln(meta);
    writeln();
  });
}

// ── State ─────────────────────────────────────────────────────────────────────
let view     = 'pending'; // 'pending' | 'done'
let cursor   = 0;
let inputMode = false;
let inputBuf  = '';
let message   = '';

function currentItems(all) {
  return all.filter((r) => view === 'done' ? r.done : !r.done);
}

function render(all) {
  clear();
  const items = currentItems(all);
  renderHeader(view);
  renderControls();
  if (message) {
    writeln(`  ${GREEN}${message}${RESET}\n`);
  }
  if (inputMode) {
    writeln(`  ${BOLD}Nueva idea:${RESET} ${inputBuf}█\n`);
  } else {
    renderList(items, cursor, view);
  }
}

// ── Input handling ────────────────────────────────────────────────────────────
function setup() {
  hideCursor();
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  let all = getRequests();
  render(all);

  process.stdin.on('keypress', (ch, key) => {
    message = '';

    if (inputMode) {
      if (key.name === 'return' || key.name === 'enter') {
        const text = inputBuf.trim();
        if (text.length >= 5) {
          addRequest(text);
          message = '✓ Idea añadida.';
          view    = 'pending';
        } else {
          message = 'Texto demasiado corto (mínimo 5 caracteres).';
        }
        inputBuf  = '';
        inputMode = false;
        all     = getRequests();
        const items = currentItems(all);
        cursor  = Math.max(0, items.length - 1);
      } else if (key.name === 'escape') {
        inputBuf  = '';
        inputMode = false;
      } else if (key.name === 'backspace') {
        inputBuf = inputBuf.slice(0, -1);
      } else if (ch && !key.ctrl && !key.meta) {
        if (inputBuf.length < 300) inputBuf += ch;
      }
      render(all);
      return;
    }

    // Navigation
    if (key.name === 'up' || ch === 'k') {
      const items = currentItems(all);
      cursor = Math.max(0, cursor - 1);
    } else if (key.name === 'down' || ch === 'j') {
      const items = currentItems(all);
      cursor = Math.min(items.length - 1, cursor + 1);
    } else if (key.name === 'tab') {
      view   = view === 'pending' ? 'done' : 'pending';
      cursor = 0;
    } else if (ch === 'd') {
      const items = currentItems(all);
      if (items[cursor]) {
        const item = items[cursor];
        markDone(item.id, !item.done);
        message = item.done ? '↩ Marcada como pendiente.' : '✓ Marcada como implementada.';
        all     = getRequests();
        const newItems = currentItems(all);
        cursor  = Math.min(cursor, Math.max(0, newItems.length - 1));
      }
    } else if (ch === 'n') {
      inputMode = true;
      inputBuf  = '';
    } else if (ch === 'x') {
      const items = currentItems(all);
      if (items[cursor]) {
        const item = items[cursor];
        deleteRequest(item.id);
        message = '🗑 Solicitud eliminada.';
        all     = getRequests();
        const newItems = currentItems(all);
        cursor  = Math.min(cursor, Math.max(0, newItems.length - 1));
      }
    } else if (ch === 'q' || (key.ctrl && key.name === 'c')) {
      cleanup();
      process.exit(0);
    }

    all = getRequests();
    render(all);
  });
}

function cleanup() {
  showCursor();
  clear();
  writeln('Hasta luego! 👋');
}

process.on('exit',    cleanup);
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

setup();
