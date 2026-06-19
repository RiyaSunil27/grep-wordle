const express = require('express');
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WORD_LIST, SECRET_WORDS } = require('./words');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MAX_GUESSES = 6;
const RUN_MS = 5 * 60 * 1000;            // 5-minute sprint
const WORDLIST_FILE = path.join(__dirname, '.wordlist.tmp');
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

// Write wordlist to disk once for grep operations
fs.writeFileSync(WORDLIST_FILE, WORD_LIST.join('\n') + '\n');

// --- Leaderboard (persisted to JSON file) ---
let leaderboard = [];
try { leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8')); } catch (_) {}
function saveLeaderboard() {
  try { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2)); } catch (_) {}
}
function topBoard(n = 10) {
  return leaderboard.slice(0, n).map((e, i) => ({ rank: i + 1, ...e }));
}

// --- In-memory stores ---
const tokens = new Map();   // token -> name (name-only auth)
const runs   = new Map();   // runId -> run

function pickSecret() {
  return SECRET_WORDS[Math.floor(Math.random() * SECRET_WORDS.length)];
}

// Score for one solved word: faster (fewer guesses) is worth more.
function wordScore(guessesUsed) {
  return 100 + (MAX_GUESSES - guessesUsed) * 20;  // 100..200
}

function scoreGuess(guess, secret) {
  const result = Array(5).fill('gray');
  const secretArr = secret.split('');
  const guessArr = guess.split('');
  const used = Array(5).fill(false);

  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === secretArr[i]) { result[i] = 'green'; used[i] = true; }
  }
  for (let i = 0; i < 5; i++) {
    if (result[i] === 'green') continue;
    for (let j = 0; j < 5; j++) {
      if (!used[j] && guessArr[i] === secretArr[j]) { result[i] = 'yellow'; used[j] = true; break; }
    }
  }
  return result;
}

function parseGrepArgs(input) {
  let s = input.trim();
  if (s.startsWith('grep ')) s = s.slice(5).trim();

  const flags = [];
  const flagMatch = s.match(/^(-[viEe]+\s+)*/);
  if (flagMatch && flagMatch[0]) {
    const flagStr = flagMatch[0].trim();
    for (const m of flagStr.matchAll(/-([viEe]+)/g)) flags.push(...m[1].split(''));
    s = s.slice(flagMatch[0].length).trim();
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  if (!s) return null;
  return { flags: [...new Set(flags)], pat: s };
}

function runGrep(input) {
  const parts = parseGrepArgs(input);
  if (!parts) return { error: 'Empty pattern' };
  const { flags, pat } = parts;

  // Safety: disallow shell metacharacters beyond what grep needs
  if (/[`$;|&<>!]/.test(pat)) return { error: 'Pattern contains disallowed characters' };

  try {
    const flagStr = flags.length ? '-' + flags.join('') : '';
    const cmd = `grep ${flagStr} "${pat.replace(/"/g, '\\"')}" "${WORDLIST_FILE}"`;
    const raw = execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim();
    const matches = raw ? raw.split('\n').filter(w => WORD_LIST.includes(w)) : [];
    return { matches, cmd: `grep ${flagStr} "${pat}"`.trim() };
  } catch (e) {
    if (e.status === 1) {
      const flagStr = flags.length ? '-' + flags.join('') : '';
      return { matches: [], cmd: `grep ${flagStr} "${pat}"`.trim() };
    }
    return { error: 'grep failed: ' + (e.message || 'unknown error') };
  }
}

// --- Run lifecycle ---
function newWord() {
  return { secret: pickSecret(), guesses: [], guessesLeft: MAX_GUESSES, status: 'playing' };
}

function tick(run) {
  if (!run.finished && Date.now() >= run.deadline) finalizeRun(run);
}

function finalizeRun(run) {
  if (run.finished) return;
  run.finished = true;
  run.current = null;
  const entry = {
    name: run.name,
    score: run.score,
    solved: run.solved,
    date: new Date().toISOString(),
  };
  leaderboard.push(entry);
  leaderboard.sort((a, b) => b.score - a.score || b.solved - a.solved || a.date.localeCompare(b.date));
  leaderboard = leaderboard.slice(0, 100);
  saveLeaderboard();
  run.rank = leaderboard.indexOf(entry) + 1;
}

function runView(run) {
  return {
    runId: run.id,
    name: run.name,
    score: run.score,
    solved: run.solved,
    failed: run.failed,
    skipped: run.skipped,
    msLeft: run.finished ? 0 : Math.max(0, run.deadline - Date.now()),
    finished: run.finished,
    rank: run.rank || null,
  };
}

function wordView(c) {
  return { guesses: c.guesses, guessesLeft: c.guessesLeft, status: c.status };
}

// --- Auth middleware ---
function authName(req) {
  const h = req.headers.authorization || '';
  const t = h.replace(/^Bearer\s+/i, '').trim();
  return tokens.get(t) || null;
}

function getRun(req, res) {
  const run = runs.get(req.params.id);
  if (!run) { res.status(404).json({ error: 'Run not found' }); return null; }
  if (run.name !== authName(req)) { res.status(403).json({ error: 'Not your run' }); return null; }
  tick(run);
  return run;
}

// ─── Routes ──────────────────────────────────────────────────

// Name-only auth: hand back a token tied to a display name.
app.post('/api/auth', (req, res) => {
  let { name } = req.body;
  if (typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  name = name.trim();
  if (!/^[\w .-]{1,20}$/.test(name)) {
    return res.status(400).json({ error: 'Name must be 1-20 chars (letters, numbers, space, . - _)' });
  }
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, name);
  res.json({ token, name });
});

app.get('/api/leaderboard', (req, res) => {
  res.json({ leaderboard: topBoard(10) });
});

app.post('/api/run/start', (req, res) => {
  const name = authName(req);
  if (!name) return res.status(401).json({ error: 'Sign in first' });

  const run = {
    id: crypto.randomBytes(12).toString('hex'),
    name,
    startedAt: Date.now(),
    deadline: Date.now() + RUN_MS,
    score: 0, solved: 0, failed: 0, skipped: 0,
    finished: false, rank: null,
    current: newWord(),
  };
  runs.set(run.id, run);
  res.json({ run: runView(run), word: wordView(run.current), durationMs: RUN_MS });
});

app.post('/api/run/:id/probe', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  if (run.finished) return res.status(400).json({ error: 'Time is up' });

  const { pattern } = req.body;
  if (!pattern || typeof pattern !== 'string') return res.status(400).json({ error: 'pattern required' });
  if (pattern.length > 200) return res.status(400).json({ error: 'Pattern too long' });

  const result = runGrep(pattern);
  if (result.error) return res.status(400).json({ error: result.error });

  res.json({ probe: { cmd: result.cmd, matches: result.matches }, run: runView(run) });
});

app.post('/api/run/:id/guess', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  if (run.finished) return res.status(400).json({ error: 'Time is up' });

  const { word } = req.body;
  if (!word || typeof word !== 'string') return res.status(400).json({ error: 'word required' });
  const guess = word.toLowerCase().trim();
  if (!/^[a-z]{5}$/.test(guess)) return res.status(400).json({ error: 'Must be 5 letters' });
  if (!WORD_LIST.includes(guess)) return res.status(400).json({ error: `"${guess}" not in word list` });

  const c = run.current;
  const colors = scoreGuess(guess, c.secret);
  c.guesses.push({ word: guess, colors });
  c.guessesLeft--;

  let ended = false, outcome = null, lastSecret = null;
  if (guess === c.secret) {
    c.status = 'won';
    run.solved++;
    run.score += wordScore(c.guesses.length);
    ended = true; outcome = 'solved'; lastSecret = c.secret;
  } else if (c.guessesLeft <= 0) {
    c.status = 'lost';
    run.failed++;
    ended = true; outcome = 'failed'; lastSecret = c.secret;
  }

  const finishedWord = wordView(c);
  tick(run);  // the guess may have crossed the deadline

  let next = null;
  if (ended && !run.finished) {
    run.current = newWord();
    next = wordView(run.current);
  }

  res.json({
    guess: { word: guess, colors },
    word: finishedWord,
    run: runView(run),
    ended, outcome, lastSecret, next,
  });
});

app.post('/api/run/:id/skip', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  if (run.finished) return res.status(400).json({ error: 'Time is up' });

  const lastSecret = run.current.secret;
  run.skipped++;
  tick(run);

  let next = null;
  if (!run.finished) { run.current = newWord(); next = wordView(run.current); }
  res.json({ run: runView(run), lastSecret, next });
});

app.post('/api/run/:id/finish', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  finalizeRun(run);
  res.json({ run: runView(run), leaderboard: topBoard(10) });
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => console.log(`grep-wordle server running on http://localhost:${PORT}`));
