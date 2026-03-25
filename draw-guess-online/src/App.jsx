import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const palette = ['#191919', '#ff6b6b', '#ff9f1c', '#2ec4b6', '#4f46e5', '#f72585']
const defaultBrush = { color: palette[0], width: 6 }
const ADMIN_TOKEN_KEY = 'sketchwave-admin-token'

const socket = io('/', {
  autoConnect: false,
})

function drawStroke(ctx, stroke) {
  if (!ctx || !stroke?.points?.length) {
    return
  }

  const [firstPoint, ...restPoints] = stroke.points
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(firstPoint.x, firstPoint.y)
  restPoints.forEach((point) => {
    ctx.lineTo(point.x, point.y)
  })
  ctx.stroke()
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(`${reader.result || ''}`)
    reader.onerror = () => reject(new Error('文件读取失败。'))
    reader.readAsText(file, 'utf-8')
  })
}

function App() {
  const canvasRef = useRef(null)
  const ctxRef = useRef(null)
  const currentStrokeRef = useRef(null)
  const redrawStrokesRef = useRef([])
  const chatListRef = useRef(null)

  const initialRoomCode = new URLSearchParams(window.location.search).get('room') || ''
  const [form, setForm] = useState({ playerName: '', roomCode: initialRoomCode.toUpperCase() })
  const [connected, setConnected] = useState(false)
  const [serviceMeta, setServiceMeta] = useState({
    databaseEnabled: false,
    words: 0,
    adminConfigured: false,
  })
  const [roomState, setRoomState] = useState({
    code: '',
    round: 0,
    maxRounds: 6,
    roundActive: false,
    timer: 80,
    hostId: '',
    drawerId: '',
    drawerName: '',
    wordCategory: '',
    players: [],
    messages: [],
    canvasStrokes: [],
    word: '等待加入房间',
  })
  const [playerId, setPlayerId] = useState('')
  const [brush, setBrush] = useState(defaultBrush)
  const [chatInput, setChatInput] = useState('')
  const [notice, setNotice] = useState('输入昵称后即可创建或加入房间。')
  const [copyState, setCopyState] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [adminToken, setAdminToken] = useState(localStorage.getItem(ADMIN_TOKEN_KEY) || '')
  const [adminMessage, setAdminMessage] = useState('登录后即可管理题库。')
  const [wordList, setWordList] = useState([])
  const [wordForm, setWordForm] = useState({ word: '', category: '' })
  const [bulkText, setBulkText] = useState('')

  const me = useMemo(
    () => roomState.players.find((player) => player.id === playerId),
    [playerId, roomState.players],
  )
  const isDrawer = roomState.drawerId === playerId
  const isHost = roomState.hostId === playerId
  const canDraw = connected && isDrawer && roomState.roundActive
  const inviteLink = roomState.code
    ? `${window.location.origin}${window.location.pathname}?room=${roomState.code}`
    : ''
  const tipText = useMemo(() => {
    if (!roomState.code) {
      return notice
    }

    if (!roomState.roundActive) {
      return '等待房主开始下一局，或正在结算本回合。'
    }

    if (isDrawer) {
      return `轮到你作画，词语是「${roomState.word}」`
    }

    if (me?.hasGuessed) {
      return '你已经猜中了，安心看大家继续发挥。'
    }

    return '观察画面，在右侧聊天框输入你的猜测。'
  }, [isDrawer, me?.hasGuessed, notice, roomState.code, roomState.roundActive, roomState.word])

  const fetchServiceMeta = useCallback(async () => {
    const response = await fetch('/api/public/health')
    const data = await response.json()
    setServiceMeta(data)
  }, [])

  const fetchWords = useCallback(async (token = adminToken) => {
    if (!token) {
      return
    }

    const response = await fetch('/api/admin/words', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    if (response.status === 401) {
      localStorage.removeItem(ADMIN_TOKEN_KEY)
      setAdminToken('')
      setWordList([])
      setAdminMessage('管理员登录已过期，请重新登录。')
      return
    }

    const data = await response.json()
    if (!response.ok) {
      setAdminMessage(data.error || '读取题库失败。')
      return
    }

    setWordList(data.items)
    setServiceMeta((previous) => ({
      ...previous,
      databaseEnabled: data.databaseEnabled,
      words: data.total,
    }))
  }, [adminToken])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      fetchServiceMeta().catch(() => {
        setNotice('服务状态读取失败，请确认后端已启动。')
      })
    }, 0)

    return () => window.clearTimeout(timer)
  }, [fetchServiceMeta])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const context = canvas.getContext('2d')
    canvas.width = 960
    canvas.height = 640
    context.fillStyle = '#fcfaf5'
    context.fillRect(0, 0, canvas.width, canvas.height)
    ctxRef.current = context
  }, [])

  useEffect(() => {
    function resetCanvas() {
      const canvas = canvasRef.current
      const context = ctxRef.current
      if (!canvas || !context) {
        return
      }
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#fcfaf5'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }

    function redrawAll(strokes) {
      resetCanvas()
      strokes.forEach((stroke) => drawStroke(ctxRef.current, stroke))
    }

    function handleConnect() {
      setConnected(true)
      setPlayerId(socket.id)
    }

    function handleDisconnect() {
      setConnected(false)
      setNotice('连接已断开，请刷新页面后重新加入。')
    }

    function handleRoomState(nextState) {
      redrawStrokesRef.current = nextState.canvasStrokes
      setRoomState(nextState)
      if (nextState.code) {
        const url = new URL(window.location.href)
        url.searchParams.set('room', nextState.code)
        window.history.replaceState({}, '', url)
      }
      redrawAll(nextState.canvasStrokes)
    }

    function handleStroke(stroke) {
      redrawStrokesRef.current = [...redrawStrokesRef.current, stroke]
      drawStroke(ctxRef.current, stroke)
    }

    function handleCanvasClear() {
      redrawStrokesRef.current = []
      redrawAll([])
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('room-state', handleRoomState)
    socket.on('draw-stroke', handleStroke)
    socket.on('canvas-clear', handleCanvasClear)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('room-state', handleRoomState)
      socket.off('draw-stroke', handleStroke)
      socket.off('canvas-clear', handleCanvasClear)
    }
  }, [])

  useEffect(() => {
    const chatList = chatListRef.current
    if (!chatList) {
      return
    }

    chatList.scrollTo({
      top: chatList.scrollHeight,
      behavior: 'smooth',
    })
  }, [roomState.messages])

  useEffect(() => {
    if (!adminToken) {
      return
    }

    const timer = window.setTimeout(() => {
      fetchWords(adminToken).catch(() => {
        setAdminMessage('题库读取失败，请稍后再试。')
      })
    }, 0)

    return () => window.clearTimeout(timer)
  }, [adminToken, fetchWords])

  function joinRoom(event) {
    event.preventDefault()

    if (!form.playerName.trim()) {
      setNotice('先输入你的昵称。')
      return
    }

    if (!socket.connected) {
      socket.connect()
    }

    socket.emit('join-room', {
      playerName: form.playerName,
      roomCode: form.roomCode,
    })

    setNotice('正在进入房间...')
  }

  function getCanvasPoint(event) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const source = 'touches' in event ? event.touches[0] : event

    return {
      x: ((source.clientX - rect.left) / rect.width) * canvas.width,
      y: ((source.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  function startStroke(event) {
    if (!canDraw) {
      return
    }

    event.preventDefault()
    const point = getCanvasPoint(event)
    currentStrokeRef.current = {
      color: brush.color,
      width: brush.width,
      points: [point],
    }
  }

  function moveStroke(event) {
    if (!canDraw || !currentStrokeRef.current) {
      return
    }

    event.preventDefault()
    const point = getCanvasPoint(event)
    const stroke = currentStrokeRef.current
    const lastPoint = stroke.points[stroke.points.length - 1]
    if (lastPoint && Math.abs(lastPoint.x - point.x) < 1 && Math.abs(lastPoint.y - point.y) < 1) {
      return
    }

    stroke.points.push(point)
    drawStroke(ctxRef.current, {
      ...stroke,
      points: stroke.points.slice(-2),
    })
  }

  function endStroke() {
    if (!canDraw || !currentStrokeRef.current) {
      return
    }

    const stroke = currentStrokeRef.current
    currentStrokeRef.current = null

    if (stroke.points.length === 1) {
      stroke.points.push({
        x: stroke.points[0].x + 0.01,
        y: stroke.points[0].y + 0.01,
      })
    }

    redrawStrokesRef.current = [...redrawStrokesRef.current, stroke]
    socket.emit('draw-stroke', stroke)
  }

  function sendMessage(event) {
    event.preventDefault()
    if (!chatInput.trim()) {
      return
    }

    socket.emit('send-message', chatInput)
    setChatInput('')
  }

  function clearCanvas() {
    if (!canDraw) {
      return
    }

    redrawStrokesRef.current = []
    const canvas = canvasRef.current
    const context = ctxRef.current
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#fcfaf5'
    context.fillRect(0, 0, canvas.width, canvas.height)
    socket.emit('clear-canvas')
  }

  async function copyInviteLink() {
    if (!inviteLink) {
      return
    }

    await navigator.clipboard.writeText(inviteLink)
    setCopyState('已复制邀请链接')
    window.setTimeout(() => setCopyState(''), 1800)
  }

  async function loginAdmin(event) {
    event.preventDefault()
    const response = await fetch('/api/admin/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: adminPassword }),
    })
    const data = await response.json()
    if (!response.ok) {
      setAdminMessage(data.error || '登录失败。')
      return
    }

    localStorage.setItem(ADMIN_TOKEN_KEY, data.token)
    setAdminToken(data.token)
    setAdminPassword('')
    setAdminMessage('管理员登录成功。')
  }

  async function addWord(event) {
    event.preventDefault()
    const response = await fetch('/api/admin/words', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(wordForm),
    })
    const data = await response.json()
    if (!response.ok) {
      setAdminMessage(data.error || '新增题目失败。')
      return
    }

    setWordForm({ word: '', category: '' })
    setAdminMessage(`已保存词语「${data.item.word}」。`)
    await fetchWords()
  }

  async function importBulkText(event) {
    event.preventDefault()
    const response = await fetch('/api/admin/words/bulk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ content: bulkText }),
    })
    const data = await response.json()
    if (!response.ok) {
      setAdminMessage(data.error || '批量导入失败。')
      return
    }

    setBulkText('')
    setAdminMessage(`批量导入完成，共写入 ${data.saved} 条题目。`)
    await fetchWords()
  }

  async function handleFileImport(event) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const content = await readFileAsText(file)
    setBulkText(content)
    setAdminMessage(`已读取文件「${file.name}」，确认后点击批量导入。`)
    event.target.value = ''
  }

  async function removeWord(id) {
    const response = await fetch(`/api/admin/words/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    })
    const data = await response.json()
    if (!response.ok) {
      setAdminMessage(data.error || '删除失败。')
      return
    }

    setAdminMessage('词语已删除。')
    await fetchWords()
  }

  function logoutAdmin() {
    localStorage.removeItem(ADMIN_TOKEN_KEY)
    setAdminToken('')
    setWordList([])
    setAdminMessage('已退出管理员登录。')
  }

  return (
    <main className="shell">
      <div className="aurora aurora-left"></div>
      <div className="aurora aurora-right"></div>

      <section className="hero-panel">
        <div className="hero-copy">
          <span className="badge">Realtime Party Game</span>
          <h1>SketchWave 你画我猜</h1>
          <p className="hero-text">
            公网可访问的多人画图猜词站点。朋友打开链接就能加入房间，题库也可以由你自己维护并保存到数据库。
          </p>

          <div className="hero-stats">
            <div className="stat-card">
              <span>房间模式</span>
              <strong>实时联机</strong>
            </div>
            <div className="stat-card">
              <span>题库总数</span>
              <strong>{serviceMeta.words}</strong>
            </div>
            <div className="stat-card">
              <span>数据库状态</span>
              <strong>{serviceMeta.databaseEnabled ? '已启用' : '未配置'}</strong>
            </div>
          </div>
        </div>

        <form className="join-card" onSubmit={joinRoom}>
          <div className="card-header">
            <h2>加入房间</h2>
            <p>{connected ? '已连接实时服务器' : '输入昵称后即可开始'}</p>
          </div>

          <label>
            昵称
            <input
              value={form.playerName}
              onChange={(event) => setForm((prev) => ({ ...prev, playerName: event.target.value }))}
              placeholder="比如：灵魂画手"
              maxLength={18}
            />
          </label>

          <label>
            房间码
            <input
              value={form.roomCode}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  roomCode: event.target.value.toUpperCase().slice(0, 4),
                }))
              }
              placeholder="留空自动创建"
              maxLength={4}
            />
          </label>

          <button className="primary-button" type="submit">
            创建 / 加入房间
          </button>

          <p className="tip">{tipText}</p>

          {inviteLink ? (
            <div className="share-box">
              <input value={inviteLink} readOnly />
              <button className="ghost-button" type="button" onClick={copyInviteLink}>
                复制链接
              </button>
              {copyState ? <span className="copy-state">{copyState}</span> : null}
            </div>
          ) : null}
        </form>
      </section>

      <section className="game-grid">
        <article className="panel stage-panel">
          <div className="panel-top">
            <div>
              <span className="eyebrow">房间信息</span>
              <h2>{roomState.code ? `房间 ${roomState.code}` : '等待玩家进入'}</h2>
            </div>

            <div className="status-group">
              <div className="pill">
                <span>回合</span>
                <strong>
                  {roomState.round}/{roomState.maxRounds}
                </strong>
              </div>
              <div className="pill timer-pill">
                <span>剩余</span>
                <strong>{roomState.timer}s</strong>
              </div>
            </div>
          </div>

          <div className="headline-bar">
            <div>
              <span className="eyebrow">当前词语</span>
              <h3>{roomState.word}</h3>
              <p className="subtitle">
                分类：{roomState.wordCategory || '等待出题'} · 当前作画：{roomState.drawerName || '未开始'}
              </p>
            </div>
            <div className="drawer-chip">{roomState.drawerName ? `${roomState.drawerName} 正在作画` : '等待开始'}</div>
          </div>

          <div className="canvas-frame">
            <canvas
              ref={canvasRef}
              onMouseDown={startStroke}
              onMouseMove={moveStroke}
              onMouseUp={endStroke}
              onMouseLeave={endStroke}
              onTouchStart={startStroke}
              onTouchMove={moveStroke}
              onTouchEnd={endStroke}
            />
          </div>

          <div className="toolbar">
            <div className="toolbar-block">
              {palette.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`color-dot ${brush.color === color ? 'active' : ''}`}
                  style={{ backgroundColor: color }}
                  onClick={() => setBrush((prev) => ({ ...prev, color }))}
                />
              ))}
            </div>

            <div className="toolbar-block">
              {[4, 8, 14].map((size) => (
                <button
                  key={size}
                  type="button"
                  className={`size-chip ${brush.width === size ? 'active' : ''}`}
                  onClick={() => setBrush((prev) => ({ ...prev, width: size }))}
                >
                  {size}px
                </button>
              ))}
            </div>

            <div className="toolbar-block toolbar-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => socket.emit('start-game')}
                disabled={!isHost || roomState.players.length < 2}
              >
                {roomState.round ? '重新开始' : '开始游戏'}
              </button>
              <button type="button" className="ghost-button" onClick={clearCanvas} disabled={!canDraw}>
                清空画板
              </button>
            </div>
          </div>
        </article>

        <aside className="sidebar">
          <article className="panel players-panel">
            <div className="panel-top">
              <div>
                <span className="eyebrow">积分榜</span>
                <h2>玩家列表</h2>
              </div>
              <span className="player-count">{roomState.players.length} 人在线</span>
            </div>

            <div className="player-list">
              {roomState.players
                .slice()
                .sort((left, right) => right.score - left.score)
                .map((player, index) => (
                  <div className={`player-card ${player.id === playerId ? 'self' : ''}`} key={player.id}>
                    <div>
                      <strong>
                        #{index + 1} {player.name}
                      </strong>
                      <p>
                        {player.isHost ? '房主' : '玩家'} · {player.isDrawer ? '作画中' : player.hasGuessed ? '已猜中' : '猜词中'}
                      </p>
                    </div>
                    <span>{player.score}</span>
                  </div>
                ))}
            </div>
          </article>

          <article className="panel chat-panel">
            <div className="panel-top">
              <div>
                <span className="eyebrow">实时聊天</span>
                <h2>猜词区</h2>
              </div>
            </div>

            <div className="messages" ref={chatListRef}>
              {roomState.messages.map((message) => (
                <div className={`message ${message.type}`} key={message.id}>
                  <span className="author">{message.author}</span>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>

            <form className="chat-form" onSubmit={sendMessage}>
              <input
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder={isDrawer ? '作画者发言会被隐藏' : '输入你的猜测...'}
                maxLength={80}
              />
              <button className="primary-button" type="submit">
                发送
              </button>
            </form>
          </article>
        </aside>
      </section>

      <section className="admin-section">
        <article className="panel admin-panel">
          <div className="panel-top">
            <div>
              <span className="eyebrow">题库管理</span>
              <h2>数据库词库后台</h2>
            </div>
            <span className="player-count">
              {serviceMeta.adminConfigured ? '管理员已配置' : '未配置管理员密码'}
            </span>
          </div>

          {!adminToken ? (
            <form className="admin-login" onSubmit={loginAdmin}>
              <input
                type="password"
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                placeholder="输入管理员密码"
              />
              <button className="secondary-button" type="submit" disabled={!serviceMeta.adminConfigured}>
                登录后台
              </button>
            </form>
          ) : (
            <div className="admin-grid">
              <form className="admin-card" onSubmit={addWord}>
                <h3>手动新增</h3>
                <input
                  value={wordForm.category}
                  onChange={(event) => setWordForm((prev) => ({ ...prev, category: event.target.value }))}
                  placeholder="分类，例如：动物"
                />
                <input
                  value={wordForm.word}
                  onChange={(event) => setWordForm((prev) => ({ ...prev, word: event.target.value }))}
                  placeholder="词语，例如：北极熊"
                />
                <button className="primary-button" type="submit">
                  保存到数据库
                </button>
              </form>

              <form className="admin-card" onSubmit={importBulkText}>
                <h3>批量导入</h3>
                <textarea
                  value={bulkText}
                  onChange={(event) => setBulkText(event.target.value)}
                  placeholder={'每行一个词，或使用“分类,词语”格式\n例如：\n动物,北极熊\n食物,寿司\n机器人'}
                  rows={8}
                />
                <div className="admin-actions">
                  <label className="file-button">
                    读取 txt/csv
                    <input type="file" accept=".txt,.csv" onChange={handleFileImport} />
                  </label>
                  <button className="primary-button" type="submit">
                    批量写入数据库
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="admin-toolbar">
            <p className="tip">{adminMessage}</p>
            {adminToken ? (
              <button className="ghost-button" type="button" onClick={logoutAdmin}>
                退出登录
              </button>
            ) : null}
          </div>

          <div className="word-list">
            {wordList.map((item) => (
              <div className="word-item" key={item.id}>
                <div>
                  <strong>{item.word}</strong>
                  <p>{item.category}</p>
                </div>
                {adminToken ? (
                  <button className="ghost-button small-button" type="button" onClick={() => removeWord(item.id)}>
                    删除
                  </button>
                ) : null}
              </div>
            ))}
            {!wordList.length ? <p className="tip">登录后台后可查看数据库中的题库列表。</p> : null}
          </div>
        </article>
      </section>
    </main>
  )
}

export default App
