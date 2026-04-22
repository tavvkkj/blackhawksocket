import { WebSocketServer } from 'ws'

const port = Number(process.env.PORT || 8787)
const rooms = new Map()

function resolvePublicWsUrl() {
  const explicit = String(process.env.PUBLIC_WS_URL || '').trim()
  if (explicit) {
    return explicit
  }

  const appUrl = String(process.env.APP_URL || process.env.PUBLIC_URL || '').trim()
  if (appUrl) {
    if (appUrl.startsWith('ws://') || appUrl.startsWith('wss://')) {
      return appUrl
    }
    if (appUrl.startsWith('https://')) {
      return `wss://${appUrl.replace('https://', '')}`
    }
    if (appUrl.startsWith('http://')) {
      return `ws://${appUrl.replace('http://', '')}`
    }
    return `wss://${appUrl}`
  }

  return ''
}

function makeId(length) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)]
  }
  return out
}

function makeUniqueRoomId() {
  let roomId = makeId(6)
  while (rooms.has(roomId)) {
    roomId = makeId(6)
  }
  return roomId
}

function send(socket, payload) {
  if (!socket || socket.readyState !== socket.OPEN) {
    return
  }
  socket.send(JSON.stringify(payload))
}

function listMembers(room) {
  return [...room.sessions.values()].map((session) => ({
    sessionId: session.sessionId,
    playerId: session.playerId,
    playerName: session.playerName,
    role: session.role,
  }))
}

function broadcastRoom(room, payload) {
  for (const session of room.sessions.values()) {
    for (const socket of session.sockets) {
      send(socket, payload)
    }
  }
}

function broadcastRoomExceptSession(room, excludedSessionId, payload) {
  for (const session of room.sessions.values()) {
    if (session.sessionId === excludedSessionId) {
      continue
    }
    for (const socket of session.sockets) {
      send(socket, payload)
    }
  }
}

function sendToSession(room, targetSessionId, payload) {
  const targetSession = room.sessions.get(targetSessionId)
  if (!targetSession) {
    return false
  }
  for (const socket of targetSession.sockets) {
    send(socket, payload)
  }
  return true
}

function broadcastRoomState(room) {
  broadcastRoom(room, {
    type: 'room_state',
    roomId: room.roomId,
    hostSessionId: room.hostSessionId,
    members: listMembers(room),
  })
}

function broadcastFeed(room, text) {
  broadcastRoom(room, { type: 'feed', text })
}

function createSession({ room, playerName, role }) {
  const sessionId = makeId(12)
  const playerId = makeId(8)
  const session = {
    roomId: room.roomId,
    sessionId,
    playerId,
    playerName: playerName || (role === 'host' ? 'Host' : 'Player'),
    role,
    sockets: new Set(),
  }
  room.sessions.set(sessionId, session)
  return session
}

function removeSocketFromSession(socket) {
  const { roomId, sessionId } = socket.data
  if (!roomId || !sessionId) {
    return
  }

  const room = rooms.get(roomId)
  if (!room) {
    socket.data.roomId = ''
    socket.data.sessionId = ''
    return
  }

  const session = room.sessions.get(sessionId)
  if (!session) {
    socket.data.roomId = ''
    socket.data.sessionId = ''
    return
  }

  session.sockets.delete(socket)
  socket.data.roomId = ''
  socket.data.sessionId = ''

  if (session.sockets.size > 0) {
    return
  }

  room.sessions.delete(sessionId)

  if (room.hostSessionId === sessionId) {
    broadcastRoom(room, { type: 'room_closed', reason: 'host_left' })
    rooms.delete(room.roomId)
    return
  }

  broadcastFeed(room, `[${room.roomId}] ${session.playerName} saiu da sala`)
  broadcastRoomState(room)
}

const wss = new WebSocketServer({ port })

wss.on('connection', (socket) => {
  socket.data = { roomId: '', sessionId: '' }
  send(socket, { type: 'connected' })

  socket.on('message', (raw) => {
    let payload
    try {
      payload = JSON.parse(String(raw))
    } catch {
      send(socket, { type: 'error', code: 'invalid_json', message: 'Invalid JSON payload.' })
      return
    }

    if (!payload || typeof payload.type !== 'string') {
      send(socket, { type: 'error', code: 'invalid_type', message: 'Message type is required.' })
      return
    }

    if (payload.type === 'create_room') {
      removeSocketFromSession(socket)

      const roomId = makeUniqueRoomId()
      const room = {
        roomId,
        hostSessionId: '',
        sessions: new Map(),
      }

      const hostSession = createSession({
        room,
        playerName: payload.playerName,
        role: 'host',
      })

      room.hostSessionId = hostSession.sessionId
      hostSession.sockets.add(socket)
      socket.data.roomId = roomId
      socket.data.sessionId = hostSession.sessionId
      rooms.set(roomId, room)

      send(socket, {
        type: 'room_created',
        roomId,
        sessionId: hostSession.sessionId,
        playerId: hostSession.playerId,
        role: hostSession.role,
        inputMode: 'hybrid',
      })

      broadcastFeed(room, `[${roomId}] ${hostSession.playerName} criou a sala`)
      broadcastRoomState(room)
      return
    }

    if (payload.type === 'join_room') {
      removeSocketFromSession(socket)

      const roomId = String(payload.roomId || '').trim().toUpperCase()
      const room = rooms.get(roomId)
      if (!room) {
        send(socket, { type: 'error', code: 'room_not_found', message: 'Sala nao encontrada.' })
        return
      }

      const guestSession = createSession({
        room,
        playerName: payload.playerName,
        role: 'guest',
      })

      guestSession.sockets.add(socket)
      socket.data.roomId = roomId
      socket.data.sessionId = guestSession.sessionId

      send(socket, {
        type: 'room_joined',
        roomId,
        sessionId: guestSession.sessionId,
        playerId: guestSession.playerId,
        role: guestSession.role,
        inputMode: 'remote',
      })

      broadcastFeed(room, `[${roomId}] ${guestSession.playerName} entrou na sala`)
      broadcastRoomState(room)
      return
    }

    if (payload.type === 'attach_session') {
      removeSocketFromSession(socket)

      const roomId = String(payload.roomId || '').trim().toUpperCase()
      const sessionId = String(payload.sessionId || '').trim()
      const playerId = String(payload.playerId || '').trim()

      const room = rooms.get(roomId)
      if (!room) {
        send(socket, { type: 'error', code: 'room_not_found', message: 'Sala nao encontrada.' })
        return
      }

      const session = room.sessions.get(sessionId)
      if (!session || session.playerId !== playerId) {
        send(socket, { type: 'error', code: 'session_not_found', message: 'Sessao invalida.' })
        return
      }

      session.sockets.add(socket)
      socket.data.roomId = roomId
      socket.data.sessionId = sessionId

      send(socket, {
        type: 'session_attached',
        roomId,
        sessionId,
        playerId,
        role: session.role,
        inputMode: session.role === 'host' ? 'hybrid' : 'remote',
      })
      return
    }

    if (payload.type === 'leave_room') {
      removeSocketFromSession(socket)
      send(socket, { type: 'room_left' })
      return
    }

    const room = rooms.get(socket.data.roomId)
    if (!room) {
      send(socket, { type: 'error', code: 'not_in_room', message: 'Voce nao esta em uma sala.' })
      return
    }

    const session = room.sessions.get(socket.data.sessionId)
    if (!session) {
      send(socket, { type: 'error', code: 'invalid_session', message: 'Sessao desconectada.' })
      return
    }

    if (payload.type === 'room_command') {
      if (session.role !== 'host') {
        send(socket, { type: 'error', code: 'forbidden', message: 'Somente host pode enviar comandos de sala.' })
        return
      }

      const command = String(payload.command || '').trim().toLowerCase()
      if (!command) {
        return
      }

      broadcastRoom(room, {
        type: 'room_command',
        roomId: room.roomId,
        command,
        sourceSessionId: session.sessionId,
      })
      broadcastFeed(room, `[${room.roomId}] Host enviou comando: ${command}`)
      return
    }

    if (payload.type === 'remote_input') {
      if (session.role !== 'guest') {
        return
      }

      const inputType = String(payload.inputType || '').trim().toLowerCase()
      if (!inputType) {
        return
      }

      sendToSession(room, room.hostSessionId, {
        type: 'remote_input',
        roomId: room.roomId,
        inputType,
        sourceSessionId: session.sessionId,
      })
      return
    }

    if (payload.type === 'webrtc_signal') {
      const targetSessionId = String(payload.targetSessionId || '').trim()
      const signal = payload.signal
      if (!targetSessionId || !signal || typeof signal !== 'object') {
        return
      }

      if (!room.sessions.has(targetSessionId)) {
        return
      }

      sendToSession(room, targetSessionId, {
        type: 'webrtc_signal',
        roomId: room.roomId,
        sourceSessionId: session.sessionId,
        targetSessionId,
        signal,
      })
      return
    }

    if (payload.type === 'game_state') {
      if (session.role !== 'host') {
        return
      }

      const stateJson = String(payload.stateJson || '').trim()
      if (!stateJson) {
        return
      }

      broadcastRoomExceptSession(room, session.sessionId, {
        type: 'game_state',
        roomId: room.roomId,
        sourceSessionId: session.sessionId,
        stateJson,
      })
      return
    }

    if (payload.type === 'feed') {
      const text = String(payload.text || '').trim()
      if (!text) {
        return
      }
      broadcastFeed(room, text)
      return
    }

    send(socket, { type: 'error', code: 'unsupported', message: `Unsupported type: ${payload.type}` })
  })

  socket.on('close', () => {
    removeSocketFromSession(socket)
  })
})

const publicWsUrl = resolvePublicWsUrl()
console.log(`BlackHawk multiplayer server running on ws://localhost:${port}`)
if (publicWsUrl) {
  console.log(`[BlackHawk] Use this URL in Vercel env VITE_MULTIPLAYER_WS_URL: ${publicWsUrl}`)
} else {
  console.log('[BlackHawk] Set PUBLIC_WS_URL in host env to print the exact WSS URL for Vercel.')
}
