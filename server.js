const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const schedule = require('node-schedule');

// 全局变量
let studentIpMap = {};          // 学号→IP绑定
let ipStudentMap = {};          // IP→学号绑定（防多号一机）
let dynamicKey = generateFourDigitKey();  // 动态密钥
let keyGenerateTime = new Date();         // 密钥生成时间

// 工具函数
function generateFourDigitKey() {
  return Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}

function isKeyValid(inputKey) {
  const now = new Date();
  const keyAge = (now - keyGenerateTime) / 1000;
  return inputKey === dynamicKey && keyAge <= 60;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(v => v.toString().padStart(2, '0')).join(':');
}

function formatIp(ip) {
  return ip.replace('::ffff:', '');
}

// 每分钟更新密钥
setInterval(() => {
  dynamicKey = generateFourDigitKey();
  keyGenerateTime = new Date();
  console.log(`[${new Date().toLocaleTimeString()}] 新密钥：${dynamicKey}`);
}, 60 * 1000);


// 动态密钥服务（3000端口）
const keyApp = express();
const KEY_PORT = 3000;
keyApp.use(express.static(path.join(__dirname, 'key-page')));
keyApp.use(cors({ origin: '*' }));
keyApp.get('/api/dynamic-key', (req, res) => {
  res.json({
    key: dynamicKey,
    generateTime: keyGenerateTime.toLocaleTimeString(),
    expireTime: new Date(keyGenerateTime.getTime() + 60000).toLocaleTimeString()
  });
});
keyApp.listen(KEY_PORT, () => {
  console.log(`动态密钥服务运行在 http://0.0.0.0:${KEY_PORT}`);
});


// 签到系统服务（6300端口）
const checkinApp = express();
const CHECKIN_PORT = 6300;
checkinApp.use(cors({ origin: '*' }));
checkinApp.use(bodyParser.json());
checkinApp.use(express.static(path.join(__dirname, 'checkin-page')));

// 数据库连接
let db;
function connectDb() {
  db = new sqlite3.Database('checkin.db', (err) => {
    if (err) {
      console.error('数据库连接失败，10秒后重试:', err.message);
      return setTimeout(connectDb, 10000);
    }
    console.log('已连接签到数据库');
    // 创建表
    db.run(`CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY,
      checkInTime TEXT,
      checkOutTime TEXT,
      duration TEXT,
      createDate TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS student_ip (
      studentId TEXT PRIMARY KEY,
      ipAddress TEXT NOT NULL,
      bindTime TEXT NOT NULL
    )`);
    // 加载绑定关系
    db.all(`SELECT studentId, ipAddress FROM student_ip`, (err, rows) => {
      if (err) console.error('加载IP绑定失败:', err.message);
      else {
        rows.forEach(row => {
          studentIpMap[row.studentId] = row.ipAddress;
          ipStudentMap[row.ipAddress] = row.studentId;
        });
        console.log(`加载IP绑定关系：共${rows.length}条记录`);
      }
    });
  });
}
connectDb();


// API接口
// 1. 登录（双向绑定校验）
checkinApp.post('/api/login', (req, res) => {
  const { studentId, inputKey } = req.body;
  const clientIp = formatIp(req.ip);

  if (!studentId || !inputKey) {
    return res.json({ success: false, msg: '请输入学号和4位密钥' });
  }
  if (inputKey.length !== 4 || isNaN(inputKey)) {
    return res.json({ success: false, msg: '密钥必须是4位数字' });
  }
  if (!isKeyValid(inputKey)) {
    return res.json({ success: false, msg: '密钥无效或已过期' });
  }

  // 防多号一机：当前IP已绑定其他学号
  if (ipStudentMap[clientIp] && ipStudentMap[clientIp] !== studentId) {
    return res.json({ 
      success: false, 
      msg: `当前设备已绑定学号：${ipStudentMap[clientIp]}，无法登录其他账号` 
    });
  }

  // 防一号多机：当前学号已绑定其他IP
  db.get(`SELECT ipAddress FROM student_ip WHERE studentId = ?`, [studentId], (err, row) => {
    if (err) {
      console.error('登录查询失败:', err);
      return res.json({ success: false, msg: '查询失败，请重试' });
    }

    if (row) {
      if (row.ipAddress !== clientIp) {
        return res.json({ 
          success: false, 
          msg: `您的学号已绑定其他设备，无法在此登录` 
        });
      }
      // 登录成功，检查是否有未完成的签到
      db.get(`SELECT checkInTime, checkOutTime FROM checkins WHERE id = ?`, [studentId], (err, checkinRow) => {
        res.json({ 
          success: true, 
          msg: '登录成功', 
          studentId, 
          clientIp,
          // 返回未完成的签到记录（用于恢复计时）
          ongoingCheckin: checkinRow && !checkinRow.checkOutTime ? checkinRow.checkInTime : null
        });
      });
    } else {
      // 新绑定
      const bindTime = new Date().toISOString();
      db.run(`INSERT INTO student_ip (studentId, ipAddress, bindTime) VALUES (?, ?, ?)`, 
        [studentId, clientIp, bindTime], 
        function(err) {
          if (err) {
            console.error('绑定IP失败:', err);
            return res.json({ success: false, msg: '绑定失败，请重试' });
          }
          studentIpMap[studentId] = clientIp;
          ipStudentMap[clientIp] = studentId;
          res.json({ success: true, msg: '登录成功（已绑定当前设备）', studentId, clientIp, ongoingCheckin: null });
        }
      );
    }
  });
});

// 2. 注销（需密钥验证）
checkinApp.post('/api/logout', (req, res) => {
  const { studentId, inputKey } = req.body;
  const clientIp = formatIp(req.ip);

  if (!studentId || !inputKey) {
    return res.json({ success: false, msg: '请输入学号和当前密钥' });
  }
  if (!isKeyValid(inputKey)) {
    return res.json({ success: false, msg: '密钥无效或已过期' });
  }
  if (!studentIpMap[studentId] || studentIpMap[studentId] !== clientIp) {
    return res.json({ success: false, msg: '未在绑定设备登录，无法注销' });
  }

  // 清除绑定关系
  const boundIp = studentIpMap[studentId];
  db.run(`DELETE FROM student_ip WHERE studentId = ?`, [studentId], (err) => {
    if (err) {
      console.error('注销失败:', err);
      return res.json({ success: false, msg: '注销失败，请重试' });
    }
    delete studentIpMap[studentId];
    delete ipStudentMap[boundIp];
    res.json({ success: true, msg: '注销成功，IP已解绑' });
  });
});

// 3. 签到
checkinApp.post('/api/checkin', (req, res) => {
  const { id } = req.body;
  const clientIp = formatIp(req.ip);

  if (!studentIpMap[id] || studentIpMap[id] !== clientIp) {
    return res.json({ success: false, msg: '请先在绑定设备登录' });
  }

  const checkInTime = new Date().toISOString();
  const createDate = checkInTime.split('T')[0];

  db.run(`INSERT OR REPLACE INTO checkins 
          (id, checkInTime, checkOutTime, duration, createDate) 
          VALUES (?, ?, NULL, NULL, ?)`, 
    [id, checkInTime, createDate], 
    (err) => {
      if (err) {
        console.error('签到失败:', err);
        return res.json({ success: false, msg: '签到失败，请重试' });
      }
      res.json({ success: true, checkInTime });
    }
  );
});

// 4. 签离
checkinApp.post('/api/checkout', (req, res) => {
  const { id } = req.body;
  const clientIp = formatIp(req.ip);

  if (!studentIpMap[id] || studentIpMap[id] !== clientIp) {
    return res.json({ success: false, msg: '请先在绑定设备登录' });
  }

  const checkOutTime = new Date().toISOString();
  db.get(`SELECT checkInTime FROM checkins WHERE id = ?`, [id], (err, row) => {
    if (err || !row || !row.checkInTime) {
      return res.json({ success: false, msg: '未找到签到记录' });
    }

    const duration = formatDuration(new Date(checkOutTime) - new Date(row.checkInTime));
    db.run(`UPDATE checkins SET checkOutTime = ?, duration = ? WHERE id = ?`,
      [checkOutTime, duration, id],
      (err) => {
        if (err) {
          console.error('签离失败:', err);
          return res.json({ success: false, msg: '签离失败，请重试' });
        }
        res.json({ success: true, checkOutTime, duration, checkInTime: row.checkInTime });
      }
    );
  });
});

// 5. 获取历史与当前签到状态
checkinApp.get('/api/status/:studentId', (req, res) => {
  const { studentId } = req.params;
  db.get(`SELECT checkInTime, checkOutTime FROM checkins WHERE id = ?`, [studentId], (err, row) => {
    if (err) return res.json({ success: false });
    res.json({ 
      success: true, 
      ongoing: row && !row.checkOutTime, 
      checkInTime: row ? row.checkInTime : null 
    });
  });
});

checkinApp.get('/api/history', (req, res) => {
  db.all(`SELECT * FROM checkins ORDER BY checkInTime DESC`, [], (err, rows) => {
    if (err) return res.json([]);
    res.json(rows);
  });
});

checkinApp.listen(CHECKIN_PORT, () => {
  console.log(`签到系统服务运行在 http://0.0.0.0:${CHECKIN_PORT}`);
});

// 每周统计
schedule.scheduleJob('0 23 * * 0', () => {
  if (!db) return;
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  weekStart.setHours(0, 0, 0, 0);
  
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() - weekEnd.getDay() + 7);
  weekEnd.setHours(23, 59, 59, 999);

  db.all(`SELECT id, SUM(
    (JULIANDAY(checkOutTime) - JULIANDAY(checkInTime)) * 86400 
  ) as totalSeconds FROM checkins 
  WHERE createDate BETWEEN ? AND ? 
  GROUP BY id`, 
  [weekStart.toISOString().split('T')[0], weekEnd.toISOString().split('T')[0]], 
  (err, rows) => {
    if (err) return;
    let content = '学号,一周总签到时长(HH:MM:SS)\n';
    rows.forEach(row => {
      const hours = Math.floor(row.totalSeconds / 3600);
      const minutes = Math.floor((row.totalSeconds % 3600) / 60);
      const seconds = Math.floor(row.totalSeconds % 60);
      content += `${row.id},${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}\n`;
    });
    const fileName = `weekly_checkin_${weekStart.toISOString().split('T')[0]}_to_${weekEnd.toISOString().split('T')[0]}.txt`;
    fs.writeFileSync(fileName, content);
  });
});