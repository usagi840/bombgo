/**
 * BOMBGO — Serveur multijoueur 1v1
 * Lancer : node server.js
 * Puis ouvrir http://localhost:3000 dans deux onglets / appareils
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// Servir les fichiers statiques (assets, index.html) depuis le même dossier
app.use(express.static(path.join(__dirname)));

// ── Constantes partagées (doivent correspondre au client) ─────────────────────
const GAME_W = 800;
const GAME_H = 600;

const PLATFORM_LAYOUTS = [
  [{x:600,y:400},{x:50,y:250},{x:750,y:220}],
  [{x:150,y:350},{x:400,y:200},{x:650,y:300},{x:400,y:470}],
  [{x:700,y:250},{x:80,y:150},{x:500,y:400}],
  [{x:300,y:420},{x:40,y:200},{x:650,y:120},{x:400,y:300}],
  [{x:200,y:380},{x:40,y:140},{x:600,y:240},{x:350,y:100}],
  [{x:200,y:150},{x:500,y:310},{x:700,y:180},{x:350,y:460}],
  [{x:100,y:380},{x:300,y:250},{x:500,y:150},{x:700,y:250}],
  [{x:50,y:380},{x:250,y:200},{x:450,y:100},{x:650,y:200}],
  [{x:400,y:380},{x:200,y:250},{x:600,y:150}],
  [{x:100,y:500},{x:300,y:350},{x:500,y:200},{x:700,y:100}]
];

// ── Salles ────────────────────────────────────────────────────────────────────
// Une salle = { id, players: Map<socketId, playerState>, gameState }
const rooms = new Map();

function makePlayerState(socketId, slot) {
  return {
    id:       socketId,
    slot,                      // 0 = joueur gauche, 1 = joueur droite
    x:        slot === 0 ? 100 : 700,
    y:        450,
    vx:       0,
    vy:       0,
    score:    0,
    lives:    3,
    dead:     false,
    nickname: 'Player',
    character:'1',
    anim:     'turn',
  };
}

function makeGameState() {
  return {
    started:      false,
    over:         false,
    winner:       null,
    level:        0,
    stars:        buildStars(),
    bombs:        [],
    nextBombId:   0,
  };
}

function buildStars() {
  const stars = [];
  for (let i = 0; i < 12; i++) {
    stars.push({ id: i, x: 12 + i * 70, y: 0, active: true });
  }
  return stars;
}

function findOrCreateRoom() {
  for (const [id, room] of rooms) {
    if (room.players.size < 2 && !room.gameState.over) return room;
  }
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  const room = { id, players: new Map(), gameState: makeGameState() };
  rooms.set(id, room);
  return room;
}

function roomPayload(room) {
  return {
    roomId:    room.id,
    players:   [...room.players.values()],
    gameState: room.gameState,
    layout:    PLATFORM_LAYOUTS[room.gameState.level],
  };
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connecté`);
  let currentRoom = null;

  // ── Rejoindre une salle ──────────────────────────────────────────────────
  socket.on('join', ({ nickname, character }) => {
    const room  = findOrCreateRoom();
    const slot  = room.players.size; // 0 ou 1
    const pState = makePlayerState(socket.id, slot);
    pState.nickname  = nickname  || 'Player';
    pState.character = character || '1';

    room.players.set(socket.id, pState);
    currentRoom = room;

    socket.join(room.id);
    socket.emit('joined', { slot, ...roomPayload(room) });

    if (room.players.size === 2) {
      room.gameState.started = true;
      io.to(room.id).emit('start', roomPayload(room));
    } else {
      socket.emit('waiting', { roomId: room.id });
    }
  });

  // ── Mise à jour de position (client → serveur → autre client) ───────────
  socket.on('move', data => {
    if (!currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (!p || p.dead) return;

    p.x    = data.x;
    p.y    = data.y;
    p.vx   = data.vx;
    p.vy   = data.vy;
    p.anim = data.anim;

    // Diffuse aux autres joueurs de la salle
    socket.to(currentRoom.id).emit('peerMove', {
      id: socket.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, anim: p.anim,
    });
  });

  // ── Étoile collectée ────────────────────────────────────────────────────
  socket.on('collectStar', ({ starId }) => {
    if (!currentRoom) return;
    const gs = currentRoom.gameState;
    const star = gs.stars.find(s => s.id === starId && s.active);
    if (!star) return; // déjà prise

    star.active = false;
    const p = currentRoom.players.get(socket.id);
    if (p) p.score += 10;

    io.to(currentRoom.id).emit('starCollected', {
      starId,
      byId:  socket.id,
      score: p ? p.score : 0,
      starsLeft: gs.stars.filter(s => s.active).length,
    });

    // Toutes les étoiles prises → nouveau niveau + bombe
    if (gs.stars.every(s => !s.active)) {
      gs.level = (gs.level + 1) % PLATFORM_LAYOUTS.length;
      gs.stars = buildStars();

      const bomb = {
        id:  gs.nextBombId++,
        x:   Phaser.rnd ? 0 : (Math.random() < 0.5 ? randInt(400,800) : randInt(0,400)),
        y:   16,
        vx:  randInt(-200, 200),
        vy:  20,
      };
      gs.bombs.push(bomb);

      io.to(currentRoom.id).emit('newLevel', {
        level:  gs.level,
        layout: PLATFORM_LAYOUTS[gs.level],
        stars:  gs.stars,
        bomb,
      });
    }
  });

  // ── Bombe touchée (vie perdue) ───────────────────────────────────────────
  socket.on('hitBomb', ({ bombId }) => {
    if (!currentRoom) return;
    const gs = currentRoom.gameState;
    const p  = currentRoom.players.get(socket.id);
    if (!p || p.dead) return;

    // Retire la bombe de la liste serveur
    gs.bombs = gs.bombs.filter(b => b.id !== bombId);

    p.lives--;
    let winner = null;

    if (p.lives <= 0) {
      p.dead = true;
      // L'autre joueur gagne
      for (const [id, op] of currentRoom.players) {
        if (id !== socket.id && !op.dead) { winner = id; break; }
      }
      gs.over   = true;
      gs.winner = winner;
    }

    io.to(currentRoom.id).emit('playerHit', {
      id:     socket.id,
      lives:  p.lives,
      dead:   p.dead,
      bombId,
      winner,
    });
  });

  // ── Rejouer ──────────────────────────────────────────────────────────────
  socket.on('requestRestart', () => {
    if (!currentRoom) return;
    currentRoom.gameState = makeGameState();
    currentRoom.gameState.started = true;
    currentRoom.players.forEach((p, id) => {
      const fresh = makePlayerState(id, p.slot);
      fresh.nickname  = p.nickname;
      fresh.character = p.character;
      currentRoom.players.set(id, fresh);
    });
    io.to(currentRoom.id).emit('restart', roomPayload(currentRoom));
  });

  // ── Déconnexion ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} déconnecté`);
    if (!currentRoom) return;
    currentRoom.players.delete(socket.id);
    io.to(currentRoom.id).emit('peerLeft', { id: socket.id });
    if (currentRoom.players.size === 0) rooms.delete(currentRoom.id);
  });
});

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Bombgo server → http://localhost:${PORT}`));
