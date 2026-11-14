const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8"));
const QUIZ = readJson("questions-avancadas.json");
const WHO = readJson("quemsou.json");
const IMP = readJson("impostor.json").categorias;

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

const server = http.createServer((req, res) => {
  let url = req.url.split("?")[0];
  if (url === "/") url = "/index.html";
  if (url === "/host") url = "/host.html";
  const file = path.resolve(PUBLIC, `.${url}`);
  const relative = path.relative(PUBLIC, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Não encontrado"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "text/plain" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

// tempos (segundos)
const QUESTION_TIME = 20;
const WHO_INTERVAL = 5;      // uma nova dica a cada 5 s
const WHO_TIME = 25;
const HINT_TIME = 20;        // vez de cada jogador dar a dica (Impostor)
const DISCUSS_TIME = 60;
const VOTE_TIME = 45;
const GUESS_TIME = 25;

const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const connected = (p) => p && p.ws && p.ws.readyState === 1;

function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}

function ranking(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ name: p.name, score: p.score, rank: i + 1 }));
}

const nameOf = (room, key) => room.players.get(key).name;
const toAll = (room, msg) => { send(room.host, msg); for (const p of room.players.values()) send(p.ws, msg); };

function clearTimers(room) {
  clearTimeout(room.timer);
  (room.clueTimers || []).forEach(clearTimeout);
  room.clueTimers = [];
}

function lobbyUpdate(room) {
  send(room.host, { t: "lobby", players: [...room.players.values()].map(p => p.name) });
}

/* ------------------------- Quiz e Quem sou eu ------------------------- */

function buildQuiz(n) {
  const selected = shuffle(QUIZ).slice(0, clamp(n, 3, QUIZ.length));
  return selected.map((q, index) => {
    const opts = q.o.map((text, i) => ({ text, ok: i === q.a }));
    const o = shuffle(opts);
    return { q: q.q, o: o.map(x => x.text), a: o.findIndex(x => x.ok), level: index >= Math.ceil(selected.length * .4) ? "ESPECIALISTA" : "AVANÇADO", ref: q.ref, explain: q.explain };
  });
}

function buildWho(n) {
  return shuffle(WHO).slice(0, clamp(n, 3, WHO.length)).map(c => ({ clues: c.c, name: c.n }));
}

function startQuestion(room) {
  clearTimers(room);
  room.state = "question";
  const q = room.questions[room.index];
  room.startedAt = Date.now();
  room.cluesShown = q.clues ? 1 : 0;
  for (const p of room.players.values()) { p.choice = null; p.delta = 0; }
  const time = q.clues ? WHO_TIME : QUESTION_TIME;
  toAll(room, {
    t: "question", i: room.index + 1, total: room.questions.length,
    q: q.clues ? "Quem sou eu?" : q.q, o: q.clues ? [] : q.o, time,
    typed: !!q.clues, level: q.level || null, clues: q.clues ? [q.clues[0]] : null,
  });
  if (q.clues) {
    for (let k = 1; k < q.clues.length; k++) {
      room.clueTimers.push(setTimeout(() => {
        room.cluesShown = k + 1;
        toAll(room, { t: "clue", text: q.clues[k] });
      }, k * WHO_INTERVAL * 1000));
    }
  }
  room.timer = setTimeout(() => reveal(room), time * 1000 + 300);
}

function reveal(room) {
  if (room.state !== "question") return;
  clearTimers(room);
  room.state = "reveal";
  const q = room.questions[room.index];
  const counts = [0, 0, 0, 0];
  for (const p of room.players.values()) if (p.choice !== null) counts[p.choice]++;
  const rank = ranking(room);
  const last = room.index + 1 >= room.questions.length;
  send(room.host, { t: "reveal", correct: q.clues ? null : q.a, counts, top: rank.slice(0, 5), last, name: q.clues ? q.name : null, ref: q.ref || null, explain: q.explain || null });
  for (const p of room.players.values()) {
    const me = rank.find(r => r.name === p.name);
    send(p.ws, {
      t: "result", correct: q.clues ? null : q.a, answer: q.clues ? q.name : q.o[q.a], choice: p.choice, right: q.clues ? !!p.right : p.choice === q.a,
      delta: p.delta, score: p.score, rank: me ? me.rank : null, total: rank.length, ref: q.ref || null, explain: q.explain || null,
    });
  }
}

function finish(room) {
  clearTimers(room);
  room.state = "end";
  const rank = ranking(room);
  send(room.host, { t: "end", rank });
  for (const p of room.players.values()) {
    const me = rank.find(r => r.name === p.name);
    send(p.ws, { t: "end", rank: me ? me.rank : null, total: rank.length, score: p.score, top: rank.slice(0, 3) });
  }
}

/* ------------------------------ Impostor ------------------------------ */

const connectedKeys = (room) => [...room.players.entries()].filter(([, p]) => connected(p)).map(([k]) => k);

function startRound(room) {
  clearTimers(room);
  const keys = connectedKeys(room);
  if (keys.length < 3) {
    send(room.host, { t: "error", msg: "Jogadores insuficientes para continuar (mínimo 3). Fim de jogo." });
    return finish(room);
  }
  room.round++;
  const cat = pick(IMP);
  const word = pick(cat.itens);
  room.cat = cat.nome;
  room.word = word;
  room.options = shuffle([word, ...shuffle(cat.itens.filter(x => x !== word)).slice(0, 5)]);
  room.impostor = pick(keys);
  room.order = shuffle(keys);
  room.turn = 0;
  room.hints = [];
  room.votes = new Map();
  room.delta = new Map();
  room.caught = false;
  room.state = "irole";
  send(room.host, { t: "irole", round: room.round, rounds: room.rounds, cat: room.cat, players: room.order.map(k => nameOf(room, k)) });
  for (const k of keys) {
    send(room.players.get(k).ws, {
      t: "irole", round: room.round, rounds: room.rounds, cat: room.cat,
      impostor: k === room.impostor, word: k === room.impostor ? null : room.word,
    });
  }
}

function nextTurn(room) {
  clearTimeout(room.timer);
  while (room.turn < room.order.length && !connected(room.players.get(room.order[room.turn]))) {
    room.hints.push({ name: nameOf(room, room.order[room.turn]), text: "—" });
    room.turn++;
  }
  if (room.turn >= room.order.length) return startDiscuss(room);
  const k = room.order[room.turn];
  const name = nameOf(room, k);
  room.state = "ihints";
  send(room.host, { t: "iturn", name, turn: room.turn + 1, total: room.order.length, hints: room.hints, order: room.order.map(x => nameOf(room, x)), cat: room.cat, time: HINT_TIME });
  for (const x of room.order) {
    send(room.players.get(x).ws, { t: "iturn", mine: x === k, name, hints: room.hints, time: HINT_TIME });
  }
  room.timer = setTimeout(() => {
    room.hints.push({ name, text: "—" });
    room.turn++;
    nextTurn(room);
  }, HINT_TIME * 1000);
}

function startDiscuss(room) {
  clearTimeout(room.timer);
  room.state = "idiscuss";
  const msg = { t: "idiscuss", hints: room.hints, time: DISCUSS_TIME, cat: room.cat };
  toAll(room, msg);
  room.timer = setTimeout(() => startVote(room), DISCUSS_TIME * 1000);
}

function startVote(room) {
  clearTimeout(room.timer);
  room.state = "ivote";
  room.votes = new Map();
  const voters = room.order.filter(k => connected(room.players.get(k)));
  send(room.host, { t: "ivote", total: voters.length, time: VOTE_TIME });
  for (const k of room.order) {
    send(room.players.get(k).ws, {
      t: "ivote", time: VOTE_TIME,
      options: room.order.filter(x => x !== k).map(x => nameOf(room, x)),
    });
  }
  room.timer = setTimeout(() => tally(room), VOTE_TIME * 1000);
}

function tally(room) {
  if (room.state !== "ivote") return;
  clearTimeout(room.timer);
  const counts = new Map(room.order.map(k => [k, 0]));
  for (const t of room.votes.values()) counts.set(t, (counts.get(t) || 0) + 1);
  const max = Math.max(...counts.values());
  const top = [...counts.entries()].filter(([, c]) => c === max);
  room.caught = max > 0 && top.length === 1 && top[0][0] === room.impostor;
  room.voteCounts = [...counts.entries()]
    .map(([k, c]) => ({ name: nameOf(room, k), count: c }))
    .sort((a, b) => b.count - a.count);
  room.delta = new Map();
  for (const [voter, target] of room.votes) {
    if (target === room.impostor) room.delta.set(voter, (room.delta.get(voter) || 0) + 100);
  }
  if (room.caught) {
    room.state = "iguess";
    send(room.host, { t: "iguess", time: GUESS_TIME });
    for (const k of room.order) {
      const p = room.players.get(k);
      if (k === room.impostor) send(p.ws, { t: "iguess", options: room.options, time: GUESS_TIME });
      else send(p.ws, { t: "iwait", title: "Impostor descoberto! 🎯", text: "Ele tem uma chance de adivinhar a palavra secreta…" });
    }
    room.timer = setTimeout(() => roundResult(room, null), GUESS_TIME * 1000);
  } else {
    roundResult(room, null);
  }
}

function roundResult(room, guess) {
  if (room.state !== "iguess" && room.state !== "ivote") return;
  clearTimeout(room.timer);
  room.state = "iresult";
  const guessedRight = guess !== null && guess === room.word;
  if (!room.caught) room.delta.set(room.impostor, (room.delta.get(room.impostor) || 0) + 300);
  else if (guessedRight) room.delta.set(room.impostor, (room.delta.get(room.impostor) || 0) + 200);
  for (const [k, d] of room.delta) room.players.get(k).score += d;
  const rank = ranking(room);
  const last = room.round >= room.rounds;
  const impName = nameOf(room, room.impostor);
  send(room.host, {
    t: "iresult", impostor: impName, word: room.word, cat: room.cat, caught: room.caught,
    guess, guessedRight, votes: room.voteCounts, top: rank.slice(0, 5), last,
  });
  for (const k of room.order) {
    const p = room.players.get(k);
    const me = rank.find(r => r.name === p.name);
    send(p.ws, {
      t: "iresult", impostor: impName, word: room.word, caught: room.caught, guess, guessedRight,
      isImpostor: k === room.impostor, delta: room.delta.get(k) || 0, score: p.score,
      rank: me ? me.rank : null, total: rank.length,
    });
  }
}

/* ------------------------------- Conexões ------------------------------ */

function resetToLobby(room) {
  clearTimers(room);
  for (const [k, p] of [...room.players]) {
    if (!connected(p)) room.players.delete(k);
    else p.score = 0;
  }
  room.state = "lobby";
  room.mode = null;
  lobbyUpdate(room);
  for (const p of room.players.values()) send(p.ws, { t: "joined", name: p.name, state: "lobby" });
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === "create") {
      const code = newCode();
      const room = { code, host: ws, players: new Map(), state: "lobby", mode: null, index: 0, questions: [], timer: null, clueTimers: [], startedAt: 0 };
      rooms.set(code, room);
      ws.room = room; ws.role = "host";
      return send(ws, { t: "created", code });
    }

    if (m.t === "join") {
      const room = rooms.get(String(m.code || "").trim());
      const name = String(m.name || "").trim().slice(0, 14);
      if (!room) return send(ws, { t: "error", msg: "Sala não encontrada. Confira o código." });
      if (!name) return send(ws, { t: "error", msg: "Digite seu nome." });
      const key = name.toLowerCase();
      const existing = room.players.get(key);
      if (existing && connected(existing)) return send(ws, { t: "error", msg: "Já existe alguém com esse nome. Use outro." });
      if (!existing && room.state !== "lobby") return send(ws, { t: "error", msg: "O jogo já começou." });
      const player = existing || { name, score: 0, choice: null, delta: 0 };
      player.ws = ws;
      room.players.set(key, player);
      ws.room = room; ws.role = "player"; ws.player = player; ws.key = key;
      send(ws, { t: "joined", name: player.name, state: room.state });
      if (room.state === "lobby") lobbyUpdate(room);
      return;
    }

    const room = ws.room;
    if (!room) return;

    if (ws.role === "host") {
      if (m.t === "start" && room.state === "lobby") {
        const mode = ["quiz", "who", "impostor"].includes(m.mode) ? m.mode : "quiz";
        const n = parseInt(m.n, 10) || 10;
        if (room.players.size === 0) return;
        if (mode === "impostor") {
          if (connectedKeys(room).length < 3) return send(ws, { t: "error", msg: "O Impostor precisa de pelo menos 3 jogadores." });
          room.mode = mode; room.rounds = clamp(n, 1, 10); room.round = 0;
          return startRound(room);
        }
        room.mode = mode;
        room.questions = mode === "who" ? buildWho(n) : buildQuiz(n);
        room.index = 0;
        return startQuestion(room);
      }
      if (m.t === "next" && room.state === "reveal") {
        if (room.index + 1 >= room.questions.length) return finish(room);
        room.index++;
        return startQuestion(room);
      }
      if (m.t === "skip" && room.state === "question") return reveal(room);
      if (m.t === "startHints" && room.state === "irole") { room.turn = 0; return nextTurn(room); }
      if (m.t === "toVote" && room.state === "idiscuss") return startVote(room);
      if (m.t === "skipVote" && room.state === "ivote") return tally(room);
      if (m.t === "inext" && room.state === "iresult") {
        if (room.round >= room.rounds) return finish(room);
        return startRound(room);
      }
      if (m.t === "again" && room.state === "end") return resetToLobby(room);
      return;
    }

    if (ws.role === "player") {
      const p = ws.player;

      if (m.t === "answer" && room.state === "question") {
        if (!p || p.choice !== null) return;
        const q = room.questions[room.index];
        let right = false;
        if (q.clues) {
          const norm = v => String(v || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().replace(/\\s+/g, " ");
          const guess = norm(m.text), answer = norm(q.name);
          right = !!guess && (guess === answer || (answer.startsWith(guess) && guess.length >= 5));
          p.choice = -1; p.right = right;
        } else {
          const choice = parseInt(m.choice, 10);
          if (!(choice >= 0 && choice <= 3)) return;
          p.choice = choice; right = choice === q.a;
        }
        if (right) {
          if (q.clues) p.delta = Math.max(200, 1200 - 200 * (room.cluesShown - 1));
          else {
            const elapsed = Math.min(QUESTION_TIME, (Date.now() - room.startedAt) / 1000);
            p.delta = Math.round(1200 - 600 * (elapsed / QUESTION_TIME));
          }
          p.score += p.delta;
        }
        send(ws, { t: "locked" });
        const answered = [...room.players.values()].filter(x => x.choice !== null).length;
        send(room.host, { t: "progress", answered, total: room.players.size });
        if (answered === room.players.size) setTimeout(() => reveal(room), 600);
        return;
      }

      if (m.t === "hint" && room.state === "ihints") {
        if (room.order[room.turn] !== ws.key) return;
        const text = String(m.text || "").trim().split(/\s+/)[0].slice(0, 20) || "—";
        room.hints.push({ name: p.name, text });
        room.turn++;
        return nextTurn(room);
      }

      if (m.t === "vote" && room.state === "ivote") {
        if (!room.order.includes(ws.key) || room.votes.has(ws.key)) return;
        const target = String(m.name || "").toLowerCase();
        if (target === ws.key || !room.order.includes(target)) return;
        room.votes.set(ws.key, target);
        const voters = room.order.filter(k => connected(room.players.get(k)));
        send(ws, { t: "iwait", title: "Voto enviado ✅", text: "Aguarde os outros jogadores votarem…" });
        send(room.host, { t: "iprogress", answered: room.votes.size, total: voters.length });
        if (voters.every(k => room.votes.has(k))) setTimeout(() => tally(room), 600);
        return;
      }

      if (m.t === "guess" && room.state === "iguess" && ws.key === room.impostor) {
        if (!room.options.includes(m.word)) return;
        return roundResult(room, m.word);
      }
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room) return;
    if (ws.role === "host") {
      clearTimers(room);
      for (const p of room.players.values()) send(p.ws, { t: "error", msg: "O anfitrião encerrou a sala.", fatal: true });
      rooms.delete(room.code);
    } else if (ws.role === "player" && room.state === "lobby") {
      room.players.delete(ws.key);
      lobbyUpdate(room);
    }
  });
});

server.listen(PORT, () => console.log(`Quiz Bíblico rodando na porta ${PORT}`));
