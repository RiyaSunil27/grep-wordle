const express = require('express');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { WORD_LIST, SECRET_WORDS } = require('./words');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MAX_GUESSES = 6;
const MAX_PROBES = 8;
const WORDLIST_FILE = path.join(__dirname, '.wordlist.tmp');

// Write wordlist to disk once for grep operations
fs.writeFileSync(WORDLIST_FILE, WORD_LIST.join('\n') + '\n');

// In-memory session store
const sessions = new Map();

function pickSecret() {
  return SECRET_WORDS[Math.floor(Math.random() * SECRET_WORDS.length)];
}

function newSession() {
  return {
    id: uuidv4(),
    secret: pickSecret(),
    guesses: [],        // [{ word, colors }]
    probes: [],         // [{ cmd, pattern, matches }]
    probesLeft: MAX_PROBES,
    guessesLeft: MAX_GUESSES,
    status: 'playing',  // playing | won | lost
  };
}

function scoreGuess(guess, secret) {
  const result = Array(5).fill('gray');
  const secretArr = secret.split('');
  const guessArr = guess.split('');
  const used = Array(5).fill(false);

  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === secretArr[i]) {
      result[i] = 'green';
      used[i] = true;
    }
  }
  for (let i = 0; i < 5; i++) {
    if (result[i] === 'green') continue;
    for (let j = 0; j < 5; j++) {
      if (!used[j] && guessArr[i] === secretArr[j]) {
        result[i] = 'yellow';
        used[j] = true;
        break;
      }
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
    for (const m of flagStr.matchAll(/-([viEe]+)/g)) {
      flags.push(...m[1].split(''));
    }
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
  if (/[`$;|&<>!]/.test(pat)) {
    return { error: 'Pattern contains disallowed characters' };
  }

  try {
    const flagStr = flags.length ? '-' + flags.join('') : '';
    const cmd = `grep ${flagStr} "${pat.replace(/"/g, '\\"')}" "${WORDLIST_FILE}"`;
    const raw = execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim();
    const matches = raw ? raw.split('\n').filter(w => WORD_LIST.includes(w)) : [];
    const displayCmd = `grep ${flagStr} "${pat}"`.trim();
    return { matches, cmd: displayCmd };
  } catch (e) {
    if (e.status === 1) {
      const flagStr = flags.length ? '-' + flags.join('') : '';
      return { matches: [], cmd: `grep ${flagStr} "${pat}"`.trim() };
    }
    return { error: 'grep failed: ' + (e.message || 'unknown error') };
  }
}

function sessionView(s) {
  return {
    id: s.id,
    guesses: s.guesses,
    probes: s.probes,
    probesLeft: s.probesLeft,
    guessesLeft: s.guessesLeft,
    status: s.status,
    secret: s.status !== 'playing' ? s.secret : undefined,
  };
}

// --- Routes ---

app.post('/api/game/new', (req, res) => {
  const s = newSession();
  sessions.set(s.id, s);
  res.json(sessionView(s));
});

app.get('/api/game/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json(sessionView(s));
});

app.post('/api/game/:id/probe', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'playing') return res.status(400).json({ error: 'Game over' });
  if (s.probesLeft <= 0) return res.status(400).json({ error: 'No probes left' });

  const { pattern } = req.body;
  if (!pattern || typeof pattern !== 'string') return res.status(400).json({ error: 'pattern required' });
  if (pattern.length > 200) return res.status(400).json({ error: 'Pattern too long' });

  const result = runGrep(pattern);
  if (result.error) return res.status(400).json({ error: result.error });

  s.probesLeft--;
  s.probes.push({ cmd: result.cmd, matches: result.matches });

  res.json({ ...sessionView(s), probe: { cmd: result.cmd, matches: result.matches } });
});

app.post('/api/game/:id/guess', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'playing') return res.status(400).json({ error: 'Game over' });
  if (s.guessesLeft <= 0) return res.status(400).json({ error: 'No guesses left' });

  const { word } = req.body;
  if (!word || typeof word !== 'string') return res.status(400).json({ error: 'word required' });

  const guess = word.toLowerCase().trim();
  if (!/^[a-z]{5}$/.test(guess)) return res.status(400).json({ error: 'Must be 5 letters' });
  if (!WORD_LIST.includes(guess)) return res.status(400).json({ error: `"${guess}" not in word list` });

  const colors = scoreGuess(guess, s.secret);
  s.guesses.push({ word: guess, colors });
  s.guessesLeft--;

  if (guess === s.secret) s.status = 'won';
  else if (s.guessesLeft === 0) s.status = 'lost';

  res.json(sessionView(s));
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => console.log(`grep-wordle server running on http://localhost:${PORT}`));
