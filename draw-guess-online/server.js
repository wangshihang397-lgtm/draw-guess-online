import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { Server } from 'socket.io'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.join(__dirname, 'dist')

const app = express()
const server = createServer(app)
const io = new Server(server, {
  cors: {
    origin: true,
  },
})

const PORT = Number(process.env.PORT || 3001)
const ROUND_SECONDS = 80
const MAX_ROUNDS = 6
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7
const DEFAULT_CATEGORY = '默认'
const DEFAULT_WORDS = [
  { word: '火箭', category: '科技' },
  { word: '奶茶', category: '生活' },
  { word: '恐龙', category: '动物' },
  { word: '钢琴', category: '音乐' },
  { word: '雪人', category: '冬日' },
  { word: '宇航员', category: '科技' },
  { word: '西瓜', category: '水果' },
  { word: '长颈鹿', category: '动物' },
  { word: '披萨', category: '美食' },
  { word: '海盗船', category: '游乐园' },
  { word: '机器人', category: '科技' },
  { word: '冰淇淋', category: '美食' },
  { word: '猫头鹰', category: '动物' },
  { word: '游乐园', category: '地点' },
  { word: '滑板', category: '运动' },
  { word: '章鱼', category: '海洋' },
  { word: '彩虹', category: '自然' },
  { word: '汉堡', category: '美食' },
  { word: '望远镜', category: '科技' },
  { word: '热气球', category: '旅行' },
]

const rooms = new Map()
let db = null
let databaseEnabled = false

app.use(express.json({ limit: '1mb' }))

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase()
}

function createRoom(code) {
  return {
    code,
    players: [],
    hostId: '',
    drawerId: '',
    round: 0,
    roundActive: false,
    word: '',
    wordCategory: '',
    canvasStrokes: [],
    messages: [],
    guessedPlayers: [],
    timer: ROUND_SECONDS,
    intervalId: null,
  }
}

function sanitizePlayer(player, room) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    isHost: room.hostId === player.id,
    hasGuessed: room.guessedPlayers.includes(player.id),
    isDrawer: room.drawerId === player.id,
  }
}

function getMaskedWord(word) {
  return word
    .split('')
    .map((character) => (character.trim() ? '_' : ' '))
    .join(' ')
}

function buildRoomState(room, socketId) {
  const isDrawer = room.drawerId === socketId
  const showWord = isDrawer || !room.roundActive

  return {
    code: room.code,
    round: room.round,
    maxRounds: MAX_ROUNDS,
    roundActive: room.roundActive,
    timer: room.timer,
    hostId: room.hostId,
    drawerId: room.drawerId,
    drawerName: room.players.find((player) => player.id === room.drawerId)?.name ?? '',
    wordCategory: room.wordCategory,
    players: room.players.map((player) => sanitizePlayer(player, room)),
    messages: room.messages,
    canvasStrokes: room.canvasStrokes,
    word:
      room.word && showWord ? room.word : room.word ? getMaskedWord(room.word) : '等待房主开始游戏',
  }
}

function emitRoomState(room) {
  room.players.forEach((player) => {
    io.to(player.id).emit('room-state', buildRoomState(room, player.id))
  })
}

function pushSystemMessage(room, text) {
  room.messages.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'system',
    author: '系统',
    text,
  })
  room.messages = room.messages.slice(-50)
}

function clearTimer(room) {
  if (room.intervalId) {
    clearInterval(room.intervalId)
    room.intervalId = null
  }
}

function makeAdminToken() {
  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + TOKEN_TTL_MS,
    }),
  ).toString('base64url')
  const signature = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function verifyAdminToken(token) {
  if (!token || !ADMIN_PASSWORD) {
    return false
  }

  const [payload, signature] = token.split('.')
  if (!payload || !signature) {
    return false
  }

  const expected = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('base64url')
  if (signature !== expected) {
    return false
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return decoded.exp > Date.now()
  } catch {
    return false
  }
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyAdminToken(token)) {
    res.status(401).json({ error: '管理员登录已过期，请重新登录。' })
    return
  }
  next()
}

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not configured. Falling back to built-in word bank.')
    return
  }

  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_SSL === 'false'
        ? false
        : {
            rejectUnauthorized: false,
          },
  })

  await db.query(`
    CREATE TABLE IF NOT EXISTS word_bank (
      id BIGSERIAL PRIMARY KEY,
      word TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT '默认',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM word_bank')
  if (rows[0]?.count === 0) {
    for (const item of DEFAULT_WORDS) {
      await db.query(
        'INSERT INTO word_bank (word, category) VALUES ($1, $2) ON CONFLICT (word) DO NOTHING',
        [item.word, item.category],
      )
    }
  }

  databaseEnabled = true
  console.log('Database ready.')
}

async function getRandomWord() {
  if (databaseEnabled) {
    const { rows } = await db.query(
      'SELECT word, category FROM word_bank ORDER BY RANDOM() LIMIT 1',
    )
    if (rows[0]) {
      return {
        word: rows[0].word,
        category: rows[0].category,
      }
    }
  }

  return DEFAULT_WORDS[Math.floor(Math.random() * DEFAULT_WORDS.length)]
}

async function listWords(limit = 200) {
  if (!databaseEnabled) {
    return DEFAULT_WORDS.map((item, index) => ({
      id: index + 1,
      word: item.word,
      category: item.category,
      created_at: new Date(0).toISOString(),
    }))
  }

  const { rows } = await db.query(
    'SELECT id, word, category, created_at FROM word_bank ORDER BY created_at DESC LIMIT $1',
    [limit],
  )
  return rows
}

async function countWords() {
  if (!databaseEnabled) {
    return DEFAULT_WORDS.length
  }

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM word_bank')
  return rows[0]?.count ?? 0
}

async function insertWord(word, category = DEFAULT_CATEGORY) {
  if (!databaseEnabled) {
    throw new Error('数据库未配置，无法保存题库。')
  }

  const normalizedWord = `${word || ''}`.trim()
  const normalizedCategory = `${category || DEFAULT_CATEGORY}`.trim() || DEFAULT_CATEGORY
  if (!normalizedWord) {
    throw new Error('词语不能为空。')
  }

  const { rows } = await db.query(
    `
      INSERT INTO word_bank (word, category)
      VALUES ($1, $2)
      ON CONFLICT (word) DO UPDATE SET category = EXCLUDED.category
      RETURNING id, word, category, created_at
    `,
    [normalizedWord, normalizedCategory],
  )
  return rows[0]
}

function parseBulkWords(content) {
  return `${content || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,，]/).map((item) => item.trim()).filter(Boolean)
      if (parts.length >= 2) {
        return {
          category: parts[0],
          word: parts.slice(1).join(' '),
        }
      }
      return {
        category: DEFAULT_CATEGORY,
        word: parts[0],
      }
    })
    .filter((item) => item.word)
}

async function bulkInsertWords(content) {
  if (!databaseEnabled) {
    throw new Error('数据库未配置，无法保存题库。')
  }

  const parsed = parseBulkWords(content)
  if (!parsed.length) {
    throw new Error('没有识别到可导入的词语。')
  }

  let saved = 0
  for (const item of parsed) {
    await db.query(
      `
        INSERT INTO word_bank (word, category)
        VALUES ($1, $2)
        ON CONFLICT (word) DO UPDATE SET category = EXCLUDED.category
      `,
      [item.word, item.category || DEFAULT_CATEGORY],
    )
    saved += 1
  }

  return {
    saved,
    parsed: parsed.length,
  }
}

async function deleteWord(id) {
  if (!databaseEnabled) {
    throw new Error('数据库未配置，无法删除题库。')
  }

  await db.query('DELETE FROM word_bank WHERE id = $1', [id])
}

async function finishRound(room, reason) {
  clearTimer(room)
  room.roundActive = false

  if (reason === 'guessed') {
    pushSystemMessage(room, `本轮结束，答案是「${room.word}」。`)
  } else if (reason === 'timeout') {
    pushSystemMessage(room, `时间到，正确答案是「${room.word}」。`)
  } else if (reason === 'drawer-left') {
    pushSystemMessage(room, `作画玩家离开了房间，本轮答案是「${room.word}」。`)
  }

  emitRoomState(room)

  setTimeout(async () => {
    const latestRoom = rooms.get(room.code)
    if (!latestRoom || latestRoom.players.length < 2) {
      return
    }

    if (latestRoom.round >= MAX_ROUNDS) {
      pushSystemMessage(latestRoom, '游戏结束，快再来一局分出真正的灵魂画手。')
      emitRoomState(latestRoom)
      return
    }

    await startRound(latestRoom)
  }, 3200)
}

async function startRound(room) {
  clearTimer(room)

  if (room.players.length < 2) {
    room.roundActive = false
    room.word = ''
    room.wordCategory = ''
    room.drawerId = ''
    room.timer = ROUND_SECONDS
    room.canvasStrokes = []
    room.guessedPlayers = []
    pushSystemMessage(room, '至少需要 2 名玩家才能开始。')
    emitRoomState(room)
    return
  }

  const previousIndex = room.players.findIndex((player) => player.id === room.drawerId)
  const nextIndex = previousIndex >= 0 ? (previousIndex + 1) % room.players.length : 0
  const drawer = room.players[nextIndex]
  const nextWord = await getRandomWord()

  room.round += 1
  room.drawerId = drawer.id
  room.word = nextWord.word
  room.wordCategory = nextWord.category
  room.roundActive = true
  room.timer = ROUND_SECONDS
  room.canvasStrokes = []
  room.guessedPlayers = []
  pushSystemMessage(
    room,
    `第 ${room.round} / ${MAX_ROUNDS} 回合开始，${drawer.name} 正在作画。题目分类：${room.wordCategory}`,
  )
  emitRoomState(room)
  io.to(room.code).emit('canvas-clear')

  room.intervalId = setInterval(() => {
    room.timer -= 1
    if (room.timer <= 0) {
      room.timer = 0
      finishRound(room, 'timeout')
      return
    }
    emitRoomState(room)
  }, 1000)
}

function maybeCleanupRoom(roomCode) {
  const room = rooms.get(roomCode)
  if (!room || room.players.length > 0) {
    return
  }

  clearTimer(room)
  rooms.delete(roomCode)
}

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    databaseEnabled,
    words: await countWords(),
  })
})

app.get('/api/public/health', async (_req, res) => {
  res.json({
    ok: true,
    databaseEnabled,
    words: await countWords(),
    adminConfigured: Boolean(ADMIN_PASSWORD),
  })
})

app.post('/api/admin/session', (req, res) => {
  const password = `${req.body?.password || ''}`
  if (!ADMIN_PASSWORD) {
    res.status(503).json({ error: '服务端尚未配置 ADMIN_PASSWORD。' })
    return
  }
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: '管理员密码不正确。' })
    return
  }

  res.json({
    token: makeAdminToken(),
  })
})

app.get('/api/admin/words', requireAdmin, async (_req, res) => {
  res.json({
    items: await listWords(),
    total: await countWords(),
    databaseEnabled,
  })
})

app.post('/api/admin/words', requireAdmin, async (req, res) => {
  try {
    const item = await insertWord(req.body?.word, req.body?.category)
    res.json({ item })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

app.post('/api/admin/words/bulk', requireAdmin, async (req, res) => {
  try {
    const result = await bulkInsertWords(req.body?.content)
    res.json(result)
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

app.delete('/api/admin/words/:id', requireAdmin, async (req, res) => {
  try {
    await deleteWord(Number(req.params.id))
    res.json({ ok: true })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomCode, playerName }) => {
    const trimmedName = `${playerName ?? ''}`.trim().slice(0, 18)
    const requestedCode = `${roomCode ?? ''}`.trim().toUpperCase()
    const code = requestedCode || generateRoomCode()
    const name = trimmedName || `玩家${Math.floor(Math.random() * 900 + 100)}`

    let room = rooms.get(code)
    if (!room) {
      room = createRoom(code)
      rooms.set(code, room)
    }

    const alreadyJoined = room.players.some((player) => player.id === socket.id)
    if (alreadyJoined) {
      emitRoomState(room)
      return
    }

    const player = {
      id: socket.id,
      name,
      score: 0,
    }

    if (!room.hostId) {
      room.hostId = socket.id
    }

    room.players.push(player)
    socket.data.roomCode = code
    socket.join(code)
    pushSystemMessage(room, `${name} 加入了房间。`)
    emitRoomState(room)
  })

  socket.on('start-game', async () => {
    const room = rooms.get(socket.data.roomCode)
    if (!room || room.hostId !== socket.id) {
      return
    }

    room.round = 0
    room.word = ''
    room.wordCategory = ''
    room.players = room.players.map((player) => ({ ...player, score: 0 }))
    room.messages = []
    room.canvasStrokes = []
    await startRound(room)
  })

  socket.on('draw-stroke', (stroke) => {
    const room = rooms.get(socket.data.roomCode)
    if (!room || room.drawerId !== socket.id || !room.roundActive) {
      return
    }

    room.canvasStrokes.push(stroke)
    room.canvasStrokes = room.canvasStrokes.slice(-800)
    socket.to(room.code).emit('draw-stroke', stroke)
  })

  socket.on('clear-canvas', () => {
    const room = rooms.get(socket.data.roomCode)
    if (!room || room.drawerId !== socket.id || !room.roundActive) {
      return
    }

    room.canvasStrokes = []
    io.to(room.code).emit('canvas-clear')
    emitRoomState(room)
  })

  socket.on('send-message', async (rawText) => {
    const room = rooms.get(socket.data.roomCode)
    if (!room) {
      return
    }

    const text = `${rawText ?? ''}`.trim().slice(0, 80)
    if (!text) {
      return
    }

    const player = room.players.find((item) => item.id === socket.id)
    if (!player) {
      return
    }

    const normalizedGuess = text.toLowerCase()
    const normalizedWord = room.word.toLowerCase()
    const guessedCorrectly =
      room.roundActive &&
      socket.id !== room.drawerId &&
      normalizedGuess === normalizedWord &&
      !room.guessedPlayers.includes(socket.id)

    if (guessedCorrectly) {
      room.guessedPlayers.push(socket.id)
      player.score += 120
      const drawer = room.players.find((item) => item.id === room.drawerId)
      if (drawer) {
        drawer.score += 60
      }
      pushSystemMessage(room, `${player.name} 猜中了答案！`)
      emitRoomState(room)

      const remainingGuessers = room.players.filter((item) => item.id !== room.drawerId).length
      if (room.guessedPlayers.length >= remainingGuessers) {
        await finishRound(room, 'guessed')
      }
      return
    }

    room.messages.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type: 'chat',
      author: player.name,
      text: room.drawerId === socket.id && room.roundActive ? '正在专心作画...' : text,
    })
    room.messages = room.messages.slice(-50)
    emitRoomState(room)
  })

  socket.on('disconnect', async () => {
    const roomCode = socket.data.roomCode
    if (!roomCode) {
      return
    }

    const room = rooms.get(roomCode)
    if (!room) {
      return
    }

    const player = room.players.find((item) => item.id === socket.id)
    room.players = room.players.filter((item) => item.id !== socket.id)
    room.guessedPlayers = room.guessedPlayers.filter((id) => id !== socket.id)

    if (player) {
      pushSystemMessage(room, `${player.name} 离开了房间。`)
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0]?.id ?? ''
    }

    if (room.drawerId === socket.id && room.roundActive) {
      await finishRound(room, 'drawer-left')
    } else {
      emitRoomState(room)
    }

    maybeCleanupRoom(roomCode)
  })
})

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      next()
      return
    }
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

await initDatabase()

server.listen(PORT, () => {
  console.log(`SketchWave server running at http://localhost:${PORT}`)
})
