# Mafia Roles

A real-time web app to randomize Mafia game roles for in-person games. Players join visible rooms (no codes). The room creator is the host, who can configure the game, choose a referee, and start/reset the game. Players persist across refresh and can auto-rejoin.

## Features

- Host, rooms, and live public room list (no room codes)
- Rooms are deleted when empty (30s grace period) or when host deletes the room
- Host picks a referee (can be self). Referee does not get a role and sees all roles when the game starts
- Roles: 1 Doctor, 1 Detective, configurable number of Mafias, rest become Citizens
- Role emojis: 🔪 Mafia, 🩺 Doctor, 🕵️ Detective, 👤 Citizen, 👁️ Referee
- Auto-rejoin: users keep their session and rejoin the same room and state after refresh
- Mobile-first, modern UI

## Quick Start (Local)

Prerequisites: Node.js 18+

```bash
npm install
npm run dev
# open http://localhost:3000
```

Alternatively:
```bash
npm start
```

The server listens on PORT (defaults to 3000).

## Deploy to Railway

1. Push this repository to GitHub
2. In Railway: New Project → Deploy from GitHub → select this repo
3. Railway auto-detects Node:
   - Install: `npm install`
   - Start: `npm start`
4. No extra configuration required; Railway provides `PORT` env var

## How It Works

- Backend: Node.js + Express + Socket.IO
- Frontend: Single-page app in `public/index.html` using Socket.IO client
- Session & reconnect: browser stores a `sessionId` and `lastRoomId` to restore membership after refresh; server re-sends the player’s role or the referee overview when rejoining an active game
- Room deletion: when the last player disconnects, a 30s timer removes the room (allows quick refresh without losing the room)

## Roles & Logic

- Exactly one Doctor and one Detective are included
- Host sets the number of Mafia via plus/minus controls
- All remaining non-referee players become Citizens
- Roles are shuffled and assigned when the host starts the game
- Players receive their role privately; the referee sees a compact grid of colored role cards (Mafia first, then Doctor, Detective, Citizens)

## Host Controls

- Set referee by tapping a player name or the Set button next to them
- Adjust Mafia count with +/− controls
- Start game → assigns and distributes roles
- Reset game → clears roles and returns everyone to the lobby view

## Realtime Events (Summary)

Client → Server:
- `hello({ sessionId?, name })`
- `createRoom({ sessionId, name, roomName })`
- `joinRoom({ sessionId, name, roomId })`
- `leaveRoom({ sessionId, roomId })`
- `deleteRoom({ sessionId, roomId })` (host)
- `setReferee({ sessionId, roomId, refereeId })` (host)
- `setMafiaCount({ sessionId, roomId, mafiaCount })` (host)
- `startGame({ sessionId, roomId })` (host)
- `resetGame({ sessionId, roomId })` (host)
- `changeName({ sessionId, newName, roomId? })`

Server → Client:
- `helloAck({ sessionId })`
- `roomsUpdated`
- `joinedRoom({ roomId })`
- `roomState(room)`
- `yourRole({ role })`
- `rolesOverview({ players: [{ name, role }] })`
- `roomDeleted`
- `errorMsg(message)`

## Structure

```
.
├─ server.js           # Express + Socket.IO server
├─ public/
│  └─ index.html      # Single-page client
├─ package.json
└─ .gitignore
```

## Configuration

- Env: `PORT` (optional; default: 3000)
- Persistence: in-memory (demo). Use a database if you need durability across restarts.

## License

MIT
