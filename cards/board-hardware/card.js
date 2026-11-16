/**
 * 板卡硬件：按手册整理的「这块板有什么 · 怎么自己验」。
 *
 * ── 它的内容从哪来 ──
 *
 * → **《ATK-DLRK3588 Buildroot 系统快速体验手册 V1.1》第二章** ✓
 *   —— **板上有什么** ✓ · **每一项的验证命令** ✓（**手册给的就是命令** ✓）。
 * → **静态写进来** ✓（**手册是静态的** ✓）→ **不假装在读板子** ✗。
 *
 * ── 三条规矩 ──
 *
 * | # | 规矩 | 为什么 |
 * |---|---|---|
 * | 1 | **每条都写出处（§2.x）** ✓ | **能翻回手册** ✓ —— **写错了要能查** ✓ |
 * | 2 | **先确认这块板是不是手册那块** ✓ | **清单不适用于别的板** ✓ → **明说** ✓（不装作适用 ✗） |
 * | 3 | **有读数的那两项给实时值** ✓ | **温度与 NPU** ✓ —— 手册 §2.16 / §2.24 ✓ |
 */

const itemsEl = document.getElementById('items');
const appliesEl = document.getElementById('applies');

/** 手册里那块板的型号关键字（**用来认「是不是这块板」** ✓） */
const BOARD_KEY = 'ATK-DLRK3588';

/**
 * **手册第二章的 26 小节** ✓（**一项一节** ✓）。
 *
 * → `cmd` 是**手册给的原命令** ✓（**不是我自己编的** ✓）。
 * → `live` 是**板型包给得出读数的项** ✓（只有两项 ✓）。
 */
const ITEMS = [
  {
    name: '用户 LED',
    spec: 'GPIO1_A3（WORKING_LEDEN_H）· 出厂当心跳灯',
    cmd: 'echo 1 > /sys/class/leds/work/brightness',
    ref: '§2.1',
  },
  {
    name: '按键',
    spec: '7 个 · 4 个接在 ADC1 通道（KEY4 V+ / KEY5 V− / KEY6 MENU / KEY7 ESC）',
    cmd: 'evtest',
    ref: '§2.2',
  },
  {
    name: 'MIPI 屏',
    spec: '5.5" 720×1280（gt911 · ADC 0）· 5.5" 1080×1920（gt911 · ADC 1410）· 10.1" 800×1280（gt928 · ADC 2748）',
    cmd: 'cat /sys/class/backlight/backlight/brightness',
    ref: '§2.3',
  },
  {
    name: 'HDMI',
    spec: 'HDMI-A-1 / A-2 · 副屏，映射主屏（竖屏会居中）',
    cmd: 'echo "output:HDMI-A-1:rotate90" > /tmp/.weston_drm.conf',
    ref: '§2.4',
  },
  {
    name: 'DP',
    spec: 'Type-C 转 DP · Type-C0 同时是 ADB 与烧写口',
    cmd: '（与 HDMI 同一条旋转配置）',
    ref: '§2.5',
  },
  {
    name: 'RTC',
    spec: 'AT8563T 外部 RTC · 纽扣电池约 3.3V',
    cmd: 'hwclock',
    ref: '§2.6',
  },
  {
    name: '音频',
    spec: 'ES8388 CODEC（2 通道 ADC/DAC + 耳机功放）',
    cmd: 'gst-play-1.0 /userdata/piano2-CoolEdit.mp3',
    ref: '§2.7',
  },
  {
    name: '摄像头',
    spec: 'MIPI CSI ×4 · 只支持 IMX415（800 万像素）· video62 / video71 / video44 / video53',
    cmd: 'gst-launch-1.0 v4l2src device=/dev/video62 ! videoconvert ! autovideosink',
    ref: '§2.8',
  },
  {
    name: 'SH3001 六轴',
    spec: 'Senodia · 加速度 ±2/4/8/16 g · 陀螺 16.4–262 LSB/°/s',
    cmd: '/opt/ui/src/apps/resource/pcba/ATK-DLRK3588/accel_test',
    ref: '§2.9',
  },
  {
    name: 'USB',
    spec: '2 × USB2.0 HOST + 2 × 全功能 Type-C（Type-C0 可做 ADB 从机）',
    cmd: 'hdparm -t /dev/sda1',
    ref: '§2.10',
  },
  {
    name: '网络',
    spec: '两颗千兆网口（10/100/1000M 自适应）· 千兆约 900 Mbit/s',
    cmd: 'iperf3 -c <服务器 IP> -i 1',
    ref: '§2.11',
  },
  {
    name: '板载 WiFi / BT',
    spec: 'RTL8733BU（USB）· wlan0 / wlan1',
    cmd: 'ifconfig wlan0 up',
    ref: '§2.12 / §2.13',
  },
  {
    name: 'TF / eMMC',
    spec: 'SD → /dev/mmcblk1p1 · eMMC → /dev/mmcblk0p8',
    cmd: 'hdparm -t /dev/mmcblk1p1',
    ref: '§2.14',
  },
  {
    name: 'ADC',
    spec: 'IIO 通道 · 屏与按键靠它识别',
    cmd: 'cat /sys/bus/iio/devices/iio:device0/in_voltage2_raw',
    ref: '§2.15',
  },
  {
    name: '主芯片温度',
    spec: 'thermal_zone0 · 超过 32°C 风扇才转',
    cmd: 'cat /sys/class/thermal/thermal_zone0/temp',
    ref: '§2.16',
    live: 'temp.soc',
    unit: '°C',
  },
  {
    name: 'CPU 频率',
    spec: 'policy0（4 小核）· policy4 / policy6（各 2 大核）',
    cmd: 'cat /sys/devices/system/cpu/cpufreq/policy0/scaling_available_frequencies',
    ref: '§2.17',
  },
  {
    name: '耳机插拔',
    spec: 'evtest 事件',
    cmd: 'evtest',
    ref: '§2.18',
  },
  {
    name: '串口',
    spec: 'UART2 / UART3（RS232 与 RS485）· 调试口 1500000 波特 · SSH root/root',
    cmd: '（手册 §2.19：RS232 与 RS485 分别测）',
    ref: '§2.19',
  },
  {
    name: 'CAN',
    spec: 'can0',
    cmd: 'cansend can0 123#DEADBEEF',
    ref: '§2.20',
  },
  {
    name: 'SATA',
    spec: '外挂硬盘 → sda · 可热插拔',
    cmd: 'fdisk -l',
    ref: '§2.21',
  },
  {
    name: 'M.2',
    spec: 'PCIe · 最高 4 GB/s',
    cmd: 'fdisk -l',
    ref: '§2.22',
  },
  {
    name: '4/5G 模块',
    spec: '模块接口（另见《ATK-DLRK3588_4G_5G 模块测试手册》）',
    cmd: '—',
    ref: '§2.23',
  },
  {
    name: 'NPU',
    spec: 'rknpu · 要跑 NPU 例程才看得到变化',
    cmd: 'cat /sys/kernel/debug/rknpu/load',
    ref: '§2.24',
    live: 'npu.usage',
    unit: '%',
  },
  {
    name: '散热风扇',
    spec: '装在核心板上 · CPU 超过 32°C 才转',
    cmd: '—',
    ref: '§2.25',
  },
  {
    name: 'PCIe WiFi / BT',
    spec: 'RTL8852BE（WiFi6 2.4G/5G + 蓝牙 5.2）',
    cmd: 'modprobe 8852be',
    ref: '§2.26',
  },
];

/** 实时读数（**只给有读数的那两项** ✓） */
const readings = new Map();

/** 一个读数 → 人话（**五态要分清** ✓ —— 「读不到」与「没变化」不是一回事 ✓） */
function liveText(reading, unit) {
  if (reading === undefined) return '…';
  const status = reading && typeof reading.status === 'string' ? reading.status : 'pending';
  if (status === 'unavailable') return '读不到';
  if (status === 'error') return '读取失败';
  if (status === 'pending') return '…';
  if (status === 'stale') {
    return typeof reading.value === 'number' ? `${reading.value}${unit}（过时）` : '…';
  }
  if (typeof reading.value !== 'number') return '…';
  return `${reading.value}${unit}`;
}

/** 清单 */
function renderItems() {
  if (!itemsEl) return;
  itemsEl.textContent = '';
  for (const item of ITEMS) {
    const li = document.createElement('li');
    li.className = 'hw__item';

    const head = document.createElement('div');
    head.className = 'hw__item-head';
    const name = document.createElement('span');
    name.className = 'hw__name';
    name.textContent = item.name;
    const ref = document.createElement('span');
    ref.className = 'hw__ref';
    ref.textContent = item.ref;
    head.appendChild(name);
    head.appendChild(ref);

    const spec = document.createElement('div');
    spec.className = 'hw__spec';
    spec.textContent = item.spec;

    const cmd = document.createElement('code');
    cmd.className = 'hw__cmd';
    cmd.textContent = item.cmd;

    li.appendChild(head);
    li.appendChild(spec);
    li.appendChild(cmd);

    if (item.live !== undefined) {
      const value = document.createElement('span');
      value.className = 'hw__live';
      value.dataset.tag = item.live;
      value.textContent = liveText(readings.get(item.live), item.unit ?? '');
      li.appendChild(value);
    }

    itemsEl.appendChild(li);
  }
}

/** 刷新那两处实时值（**不重画整张清单** ✓ —— 免得滚动位置跳了 ✗） */
function refreshLive() {
  for (const el of document.querySelectorAll('.hw__live')) {
    const tag = el.dataset.tag;
    if (tag === undefined) continue;
    const item = ITEMS.find((i) => i.live === tag);
    el.textContent = liveText(readings.get(tag), item?.unit ?? '');
  }
}

/** 这块板是不是手册那块 */
function renderApplies(model) {
  if (!appliesEl) return;
  if (model === undefined) {
    appliesEl.textContent = '板子还没接上 · 清单来自手册';
    return;
  }
  if (model.includes(BOARD_KEY)) {
    appliesEl.textContent = `本板：${model}`;
    appliesEl.classList.add('is-ok');
    return;
  }
  // **不适用于这块板** ✓ —— **明说** ✓（不装作适用 ✗）
  appliesEl.textContent = `这块板是「${model}」· 下面的清单是 ${BOARD_KEY} 手册的，不一定适用`;
  appliesEl.classList.add('is-warn');
}

/** 订阅一个 tag（**读不到就重试** ✓ —— 同别的卡的做法 ✓） */
function subscribeWithRetry(name, cb) {
  let stopped = false;
  const attempt = () => {
    if (stopped) return;
    Promise.resolve(cockpit.tags.subscribe(name, cb)).then(
      (result) => {
        if (result && result.ok === false && result.reason === 'not_connected') {
          setTimeout(attempt, 150);
        }
      },
      () => setTimeout(attempt, 150),
    );
  };
  attempt();
  return () => {
    stopped = true;
  };
}

renderItems();

for (const name of ['board.model', 'temp.soc', 'npu.usage']) {
  subscribeWithRetry(name, (reading) => {
    readings.set(name, reading);
    if (name === 'board.model') {
      renderApplies(typeof reading.value === 'string' ? reading.value : undefined);
      return;
    }
    refreshLive();
  });
}

setInterval(refreshLive, 1000);
