const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	cors: { origin: '*' }
});

// In-memory state (for demo). For production, use a DB.
const rooms = new Map(); // roomId -> { id, name, hostId, players: Map(sessionId -> player), refereeId|null, settings, started, rolesAssignedAt }
const roomDeletionTimers = new Map(); // roomId -> timeoutId
// player: { sessionId, name, socketId, roomId, isHost, isReferee, role|null, connected }

app.use(express.static(path.join(__dirname, 'public')));

// Simple endpoint to get room list
app.get('/api/rooms', (req, res) => {
	const visibleRooms = Array.from(rooms.values()).map(r => ({
		id: r.id,
		name: r.name,
		hostId: r.hostId,
		playerCount: Array.from(r.players.values()).filter(p => p.connected).length,
		started: r.started,
		settings: r.settings
	}));
	res.json(visibleRooms);
});

function createRoom(name, hostPlayer) {
	const id = uuidv4().slice(0, 6);
	const room = {
		id,
		name,
		hostId: hostPlayer.sessionId,
		players: new Map([[hostPlayer.sessionId, { ...hostPlayer, isHost: true, isReferee: false, role: null, connected: true, roomId: id }]]),
		refereeId: null,
		settings: { mafiaCount: 1 },
		started: false,
		rolesAssignedAt: null
	};
	rooms.set(id, room);
	return room;
}

function deleteRoomIfEmpty(roomId) {
	const room = rooms.get(roomId);
	if (!room) return;
	const hasAnyConnected = Array.from(room.players.values()).some(p => p.connected);
	if (!hasAnyConnected) {
		if (!roomDeletionTimers.has(roomId)) {
			const timeoutId = setTimeout(() => {
				rooms.delete(roomId);
				roomDeletionTimers.delete(roomId);
				io.emit('roomsUpdated');
			}, 30000); // 30s grace period
			roomDeletionTimers.set(roomId, timeoutId);
		}
	} else {
		const t = roomDeletionTimers.get(roomId);
		if (t) {
			clearTimeout(t);
			roomDeletionTimers.delete(roomId);
		}
	}
}

function findOrCreatePlayer(sessionId, name, socketId) {
	return { sessionId, name, socketId, isHost: false, isReferee: false, role: null, connected: true, roomId: null };
}

function assignRoles(room) {
	// Build list of active players excluding referee
	const activePlayers = Array.from(room.players.values()).filter(p => p.connected && !p.isReferee);
	if (activePlayers.length < 3) return { error: 'Need at least 3 players (excluding referee)' };
	const mafiaCount = Math.max(0, Number(room.settings.mafiaCount || 1));
	const roles = [];
	roles.push('Doctor');
	roles.push('Detective');
	for (let i = 0; i < mafiaCount; i++) roles.push('Mafia');
	// Fill remaining as Citizen
	while (roles.length < activePlayers.length) roles.push('Citizen');
	// Shuffle
	for (let i = roles.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[roles[i], roles[j]] = [roles[j], roles[i]];
	}
	activePlayers.forEach((p, idx) => {
		p.role = roles[idx];
	});
	room.started = true;
	room.rolesAssignedAt = Date.now();
	return { ok: true };
}

io.on('connection', (socket) => {
	let currentSessionId = null;

	socket.on('hello', ({ sessionId, name }) => {
		currentSessionId = sessionId || uuidv4();
		socket.emit('helloAck', { sessionId: currentSessionId });
	});

	socket.on('createRoom', ({ sessionId, name, roomName }) => {
		const player = findOrCreatePlayer(sessionId || uuidv4(), name, socket.id);
		const room = createRoom(roomName || `Room-${Math.floor(Math.random()*1000)}`, player);
		socket.join(room.id);
		deleteRoomIfEmpty(room.id); // ensure no pending deletion
		io.emit('roomsUpdated');
		io.to(room.id).emit('roomState', serializeRoom(room));
		socket.emit('joinedRoom', { roomId: room.id });
	});

	socket.on('joinRoom', ({ sessionId, name, roomId }) => {
		const room = rooms.get(roomId);
		if (!room) {
			socket.emit('errorMsg', 'Room not found');
			return;
		}
		let player = room.players.get(sessionId);
		if (!player) {
			player = findOrCreatePlayer(sessionId || uuidv4(), name, socket.id);
			player.roomId = roomId;
			room.players.set(player.sessionId, player);
		} else {
			player.connected = true;
			player.socketId = socket.id;
		}
		socket.join(room.id);
		deleteRoomIfEmpty(room.id); // cancel pending deletion if any
		io.emit('roomsUpdated');
		io.to(room.id).emit('roomState', serializeRoom(room));
		socket.emit('joinedRoom', { roomId: room.id });
		// If game already started, restore view for returning player
		if (room.started) {
			if (player.isReferee) {
				io.to(socket.id).emit('rolesOverview', getRolesOverview(room));
			} else if (player.role) {
				io.to(socket.id).emit('yourRole', { role: player.role });
			}
		}
	});

	socket.on('leaveRoom', ({ sessionId, roomId }) => {
		const room = rooms.get(roomId);
		if (!room) return;
		const player = room.players.get(sessionId);
		if (player) {
			player.connected = false;
			player.isReferee = false;
			player.isHost = player.sessionId === room.hostId; // keep host flag, but disconnected
		}
		socket.leave(roomId);
		io.to(roomId).emit('roomState', serializeRoom(room));
		deleteRoomIfEmpty(roomId);
		io.emit('roomsUpdated');
	});

	socket.on('deleteRoom', ({ sessionId, roomId }) => {
		const room = rooms.get(roomId);
		if (!room) return;
		if (room.hostId !== sessionId) return;
		rooms.delete(roomId);
		const t = roomDeletionTimers.get(roomId);
		if (t) {
			clearTimeout(t);
			roomDeletionTimers.delete(roomId);
		}
		io.to(roomId).emit('roomDeleted');
		io.emit('roomsUpdated');
	});

	socket.on('setReferee', ({ sessionId, roomId, refereeId }) => {
		const room = rooms.get(roomId);
		if (!room) return;
		if (room.hostId !== sessionId) return;
		// clear previous
		for (const p of room.players.values()) {
			p.isReferee = false;
		}
		const ref = room.players.get(refereeId);
		if (ref) {
			ref.isReferee = true;
		}
		room.refereeId = refereeId || null;
		io.to(roomId).emit('roomState', serializeRoom(room));
	});

	socket.on('setMafiaCount', ({ sessionId, roomId, mafiaCount }) => {
		const room = rooms.get(roomId);
		if (!room) return;
		if (room.hostId !== sessionId) return;
		room.settings.mafiaCount = Math.max(0, Math.min(10, Number(mafiaCount || 1)));
		io.to(roomId).emit('roomState', serializeRoom(room));
	});

	// Change display name
	socket.on('changeName', ({ sessionId, newName, roomId }) => {
		if (!newName || typeof newName !== 'string') return;
		const trimmed = newName.trim().slice(0, 32);
		if (!trimmed) return;
		const updateInRoom = (room) => {
			const player = room.players.get(sessionId);
			if (player) {
				player.name = trimmed;
				io.to(room.id).emit('roomState', serializeRoom(room));
				return true;
			}
			return false;
		};
		if (roomId) {
			const room = rooms.get(roomId);
			if (room) updateInRoom(room);
		} else {
			for (const room of rooms.values()) {
				if (updateInRoom(room)) break;
			}
		}
	});

	socket.on('startGame', ({ sessionId, roomId }) => {
		const room = rooms.get(roomId);
		if (!room) return;
		if (room.hostId !== sessionId) return;
		const res = assignRoles(room);
		if (res && res.error) {
			io.to(roomId).emit('errorMsg', res.error);
			return;
		}
		// Notify each player their role; referee gets everyone
		for (const p of room.players.values()) {
			if (!p.connected) continue;
			if (p.isReferee) {
				io.to(p.socketId).emit('rolesOverview', getRolesOverview(room));
			} else {
				io.to(p.socketId).emit('yourRole', { role: p.role });
			}
		}
		io.to(roomId).emit('roomState', serializeRoom(room));
	});

	socket.on('resetGame', ({ sessionId, roomId }) => {
		const room = rooms.get(roomId);
		if (!room) return;
		if (room.hostId !== sessionId) return;
		for (const p of room.players.values()) {
			p.role = null;
		}
		room.started = false;
		room.rolesAssignedAt = null;
		io.to(roomId).emit('roomState', serializeRoom(room));
	});

	socket.on('disconnect', () => {
		// mark player disconnected if we can find them
		for (const room of rooms.values()) {
			for (const p of room.players.values()) {
				if (p.socketId === socket.id) {
					p.connected = false;
					break;
				}
			}
			deleteRoomIfEmpty(room.id);
		}
		io.emit('roomsUpdated');
	});
});

function serializeRoom(room) {
	return {
		id: room.id,
		name: room.name,
		hostId: room.hostId,
		players: Array.from(room.players.values()).map(p => ({
			sessionId: p.sessionId,
			name: p.name,
			isHost: p.isHost,
			isReferee: p.isReferee,
			connected: p.connected,
			role: p.role && p.isReferee ? p.role : (room.started ? (p.isReferee ? null : (p.sessionId === room.hostId ? null : null)) : null) // role never exposed to others
		})),
		refereeId: room.refereeId,
		settings: room.settings,
		started: room.started
	};
}

function getRolesOverview(room) {
	return {
		players: Array.from(room.players.values()).filter(p => !p.isReferee).map(p => ({ sessionId: p.sessionId, name: p.name, role: p.role }))
	};
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});


