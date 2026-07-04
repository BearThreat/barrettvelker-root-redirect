(() => {
  "use strict";

  const canvas = document.getElementById("arena");
  const ctx = canvas.getContext("2d", { alpha: false });
  const playerScoreEl = document.getElementById("playerScore");
  const aiScoreEl = document.getElementById("aiScore");
  const fpsEl = document.getElementById("fps");
  const chargeMeter = document.getElementById("chargeMeter");
  const armorMeter = document.getElementById("armorMeter");
  const audioButton = document.getElementById("audioButton");
  const resetButton = document.getElementById("resetButton");
  const inputStatus = document.getElementById("inputStatus");
  const hapticStatus = document.getElementById("hapticStatus");
  const moveStick = document.getElementById("moveStick");
  const firePad = document.getElementById("firePad");

  const world = { width: 1280, height: 720 };
  const keys = new Set();
  const pointer = { x: world.width / 2, y: world.height / 2, down: false };
  const touchMove = { active: false, x: 0, y: 0 };
  const touchFire = { active: false };
  const bullets = [];
  const sparks = [];
  const obstacles = [
    { x: 360, y: 170, w: 90, h: 230 },
    { x: 805, y: 320, w: 110, h: 250 },
    { x: 570, y: 92, w: 165, h: 72 },
    { x: 518, y: 558, w: 210, h: 70 },
  ];

  const aimOrigin = {
    originSpace: "world",
    originKind: "turretMuzzle",
    offset: { x: 30, y: 0 },
    constraints: { maxDistance: 620, deadzone: 10 },
    smoothing: 0.24,
    fallback: { originKind: "tankCenter", offset: { x: 0, y: 0 } },
  };

  let audioContext = null;
  let lastTime = performance.now();
  let fpsAvg = 60;
  let playerScore = 0;
  let aiScore = 0;
  let gamepadIndex = null;

  const player = makeTank(170, world.height / 2, "#2fb172", true);
  const enemies = [
    makeTank(1030, 160, "#d27a9e", false),
    makeTank(1055, 560, "#f0b65a", false),
  ];

  function makeTank(x, y, color, isPlayer) {
    return {
      x,
      y,
      vx: 0,
      vy: 0,
      angle: 0,
      turret: isPlayer ? 0 : Math.PI,
      turretTarget: isPlayer ? 0 : Math.PI,
      radius: 23,
      color,
      armor: 100,
      reload: 0,
      charge: 0,
      charging: false,
      isPlayer,
      aiBias: Math.random() * Math.PI * 2,
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerpAngle(current, target, amount) {
    let delta = ((target - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    return current + delta * amount;
  }

  function length(x, y) {
    return Math.hypot(x, y);
  }

  function normalize(x, y) {
    const mag = length(x, y) || 1;
    return { x: x / mag, y: y / mag };
  }

  function tankAimOrigin(tank, config = aimOrigin) {
    if (config.originKind === "turretMuzzle") {
      return {
        x: tank.x + Math.cos(tank.turret) * (tank.radius + config.offset.x),
        y: tank.y + Math.sin(tank.turret) * (tank.radius + config.offset.x),
      };
    }

    if (config.fallback?.originKind === "tankCenter") {
      return { x: tank.x + config.fallback.offset.x, y: tank.y + config.fallback.offset.y };
    }

    return { x: tank.x, y: tank.y };
  }

  function playTone(frequency, duration, type = "sine", gain = 0.05) {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const amp = audioContext.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    amp.gain.setValueAtTime(gain, now);
    amp.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(amp).connect(audioContext.destination);
    osc.start(now);
    osc.stop(now + duration);
  }

  async function rumble(strength = 0.35, duration = 90) {
    const pad = getGamepad();
    const actuator = pad?.vibrationActuator;
    if (actuator?.playEffect) {
      try {
        await actuator.playEffect("dual-rumble", {
          duration,
          strongMagnitude: strength,
          weakMagnitude: strength * 0.55,
        });
        hapticStatus.textContent = "Controller haptics";
        return;
      } catch {
        hapticStatus.textContent = "Haptics unavailable";
      }
    }

    if (navigator.vibrate) {
      navigator.vibrate(Math.round(duration * 0.65));
      hapticStatus.textContent = "Device vibration";
    }
  }

  function getGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (gamepadIndex !== null && pads[gamepadIndex]) return pads[gamepadIndex];
    for (const pad of pads) {
      if (pad) {
        gamepadIndex = pad.index;
        inputStatus.textContent = pad.id.slice(0, 28);
        return pad;
      }
    }
    return null;
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * world.width,
      y: ((event.clientY - rect.top) / rect.height) * world.height,
    };
  }

  function rectCircleHit(rect, x, y, radius) {
    const nearX = clamp(x, rect.x, rect.x + rect.w);
    const nearY = clamp(y, rect.y, rect.y + rect.h);
    return length(x - nearX, y - nearY) < radius;
  }

  function moveTank(tank, ax, ay, dt) {
    const accel = tank.isPlayer ? 760 : 560;
    const maxSpeed = tank.isPlayer ? 260 : 205;
    const drag = Math.pow(0.0009, dt);
    tank.vx = (tank.vx + ax * accel * dt) * drag;
    tank.vy = (tank.vy + ay * accel * dt) * drag;
    const speed = length(tank.vx, tank.vy);
    if (speed > maxSpeed) {
      tank.vx = (tank.vx / speed) * maxSpeed;
      tank.vy = (tank.vy / speed) * maxSpeed;
    }

    const oldX = tank.x;
    const oldY = tank.y;
    tank.x = clamp(tank.x + tank.vx * dt, tank.radius + 10, world.width - tank.radius - 10);
    tank.y = clamp(tank.y + tank.vy * dt, tank.radius + 10, world.height - tank.radius - 10);

    for (const obstacle of obstacles) {
      if (rectCircleHit(obstacle, tank.x, tank.y, tank.radius)) {
        tank.x = oldX;
        tank.y = oldY;
        tank.vx *= -0.18;
        tank.vy *= -0.18;
      }
    }

    if (length(tank.vx, tank.vy) > 12) {
      tank.angle = Math.atan2(tank.vy, tank.vx);
    }
  }

  function startCharge(tank) {
    if (tank.reload > 0 || tank.charging) return;
    tank.charging = true;
    tank.charge = Math.max(tank.charge, 0.16);
  }

  function releaseCharge(tank) {
    if (!tank.charging || tank.reload > 0) return;
    const power = clamp(tank.charge, 0.18, 1);
    const origin = tankAimOrigin(tank);
    bullets.push({
      x: origin.x,
      y: origin.y,
      vx: Math.cos(tank.turret) * (520 + 360 * power),
      vy: Math.sin(tank.turret) * (520 + 360 * power),
      radius: 6 + power * 3,
      owner: tank.isPlayer ? "player" : "ai",
      contacts: 0,
      age: 0,
      damage: 24 + power * 32,
    });
    tank.reload = 0.28;
    tank.charging = false;
    tank.charge = 0;
    playTone(120 + power * 140, 0.13, "sawtooth", 0.045 + power * 0.05);
    rumble(0.28 + power * 0.42, 70 + power * 90);
  }

  function spark(x, y, color, amount = 12) {
    for (let i = 0; i < amount; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 190;
      sparks.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.32 + Math.random() * 0.35,
        color,
      });
    }
  }

  function damageTank(tank, bullet) {
    tank.armor -= bullet.damage;
    spark(bullet.x, bullet.y, bullet.owner === "player" ? "#2fb172" : "#d27a9e", 18);
    playTone(70, 0.2, "square", 0.08);
    rumble(0.7, 150);

    if (tank.armor <= 0) {
      if (tank.isPlayer) aiScore += 1;
      else playerScore += 1;
      resetTank(tank);
    }
  }

  function resetTank(tank) {
    const spawn = tank.isPlayer
      ? { x: 170, y: world.height / 2 }
      : { x: 1020 + Math.random() * 90, y: 120 + Math.random() * 480 };
    tank.x = spawn.x;
    tank.y = spawn.y;
    tank.vx = 0;
    tank.vy = 0;
    tank.armor = 100;
    tank.reload = 0.7;
    tank.charge = 0;
    tank.charging = false;
  }

  function resetGame() {
    playerScore = 0;
    aiScore = 0;
    bullets.length = 0;
    sparks.length = 0;
    resetTank(player);
    enemies.forEach(resetTank);
  }

  function updatePlayer(dt) {
    let ax = 0;
    let ay = 0;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) ax -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) ax += 1;
    if (keys.has("KeyW") || keys.has("ArrowUp")) ay -= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) ay += 1;

    const pad = getGamepad();
    if (pad) {
      const lx = Math.abs(pad.axes[0]) > 0.14 ? pad.axes[0] : 0;
      const ly = Math.abs(pad.axes[1]) > 0.14 ? pad.axes[1] : 0;
      const rx = Math.abs(pad.axes[2]) > 0.16 ? pad.axes[2] : 0;
      const ry = Math.abs(pad.axes[3]) > 0.16 ? pad.axes[3] : 0;
      ax += lx;
      ay += ly;
      if (rx || ry) {
        pointer.x = player.x + rx * 420;
        pointer.y = player.y + ry * 420;
      }
      const trigger = pad.buttons[7]?.value > 0.25 || pad.buttons[0]?.pressed;
      if (trigger) startCharge(player);
      else releaseCharge(player);
    }

    if (touchMove.active) {
      ax += touchMove.x;
      ay += touchMove.y;
    }

    const dir = normalize(ax, ay);
    moveTank(player, ax || ay ? dir.x : 0, ax || ay ? dir.y : 0, dt);

    const origin = tankAimOrigin(player);
    const aimDistance = length(pointer.x - origin.x, pointer.y - origin.y);
    if (aimDistance > aimOrigin.constraints.deadzone) {
      const target = Math.atan2(pointer.y - origin.y, pointer.x - origin.x);
      player.turretTarget = target;
    }
    player.turret = lerpAngle(player.turret, player.turretTarget, aimOrigin.smoothing);

    if (pointer.down || keys.has("Space") || touchFire.active) startCharge(player);
    if (!pointer.down && !keys.has("Space") && !touchFire.active) releaseCharge(player);
  }

  function updateAi(dt) {
    for (const enemy of enemies) {
      const toPlayer = normalize(player.x - enemy.x, player.y - enemy.y);
      const strafe = {
        x: Math.cos(enemy.aiBias) * 0.35,
        y: Math.sin(enemy.aiBias) * 0.35,
      };
      enemy.aiBias += dt * 0.6;
      moveTank(enemy, toPlayer.x * 0.74 + strafe.x, toPlayer.y * 0.74 + strafe.y, dt);

      const origin = tankAimOrigin(enemy);
      const lead = {
        x: player.x + player.vx * 0.24,
        y: player.y + player.vy * 0.24,
      };
      enemy.turretTarget = Math.atan2(lead.y - origin.y, lead.x - origin.x);
      enemy.turret = lerpAngle(enemy.turret, enemy.turretTarget, 0.08);

      const aimed = Math.abs(((enemy.turretTarget - enemy.turret + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.18;
      const distance = length(player.x - enemy.x, player.y - enemy.y);
      if (aimed && distance < 620 && enemy.reload <= 0) {
        startCharge(enemy);
      }
      if (enemy.charging && enemy.charge > 0.54 + Math.random() * 0.16) {
        releaseCharge(enemy);
      }
    }
  }

  function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i -= 1) {
      const b = bullets[i];
      b.age += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      let bounced = false;
      if (b.x < b.radius + 8 || b.x > world.width - b.radius - 8) {
        b.vx *= -1;
        b.x = clamp(b.x, b.radius + 8, world.width - b.radius - 8);
        bounced = true;
      }
      if (b.y < b.radius + 8 || b.y > world.height - b.radius - 8) {
        b.vy *= -1;
        b.y = clamp(b.y, b.radius + 8, world.height - b.radius - 8);
        bounced = true;
      }

      for (const obstacle of obstacles) {
        if (!rectCircleHit(obstacle, b.x, b.y, b.radius)) continue;
        const fromLeft = Math.abs(b.x - obstacle.x);
        const fromRight = Math.abs(b.x - (obstacle.x + obstacle.w));
        const fromTop = Math.abs(b.y - obstacle.y);
        const fromBottom = Math.abs(b.y - (obstacle.y + obstacle.h));
        const min = Math.min(fromLeft, fromRight, fromTop, fromBottom);
        if (min === fromLeft || min === fromRight) b.vx *= -1;
        else b.vy *= -1;
        bounced = true;
      }

      if (bounced) {
        b.contacts += 1;
        spark(b.x, b.y, "#f0b65a", 7);
        playTone(260 + b.contacts * 90, 0.055, "triangle", 0.025);
      }

      const targets = b.owner === "player" ? enemies : [player];
      for (const target of targets) {
        if (length(b.x - target.x, b.y - target.y) < target.radius + b.radius) {
          damageTank(target, b);
          bullets.splice(i, 1);
          break;
        }
      }

      if (bullets[i] && (b.contacts >= 2 || b.age > 6)) {
        spark(b.x, b.y, "#d7efe2", 8);
        bullets.splice(i, 1);
      }
    }
  }

  function updateSparks(dt) {
    for (let i = sparks.length - 1; i >= 0; i -= 1) {
      const s = sparks[i];
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= Math.pow(0.05, dt);
      s.vy *= Math.pow(0.05, dt);
      if (s.life <= 0) sparks.splice(i, 1);
    }
  }

  function drawTank(tank) {
    ctx.save();
    ctx.translate(tank.x, tank.y);
    ctx.rotate(tank.angle);
    ctx.fillStyle = "#0a0f0d";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 3;
    roundRect(-28, -20, 56, 40, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = tank.color;
    roundRect(-22, -15, 44, 30, 6);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(tank.x, tank.y);
    ctx.rotate(tank.turret);
    ctx.fillStyle = "#101715";
    roundRect(0, -6, 52, 12, 5);
    ctx.fill();
    ctx.fillStyle = tank.color;
    roundRect(14, -4, 42, 8, 4);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.fillStyle = "#0a0f0d";
    ctx.fill();
    ctx.strokeStyle = tank.color;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();

    const armorWidth = 54;
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.fillRect(tank.x - armorWidth / 2, tank.y - 40, armorWidth, 5);
    ctx.fillStyle = tank.armor > 45 ? tank.color : "#dc5e68";
    ctx.fillRect(tank.x - armorWidth / 2, tank.y - 40, armorWidth * clamp(tank.armor / 100, 0, 1), 5);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function draw() {
    ctx.fillStyle = "#0d1210";
    ctx.fillRect(0, 0, world.width, world.height);

    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.lineWidth = 1;
    for (let x = 40; x < world.width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, world.height);
      ctx.stroke();
    }
    for (let y = 40; y < world.height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(world.width, y);
      ctx.stroke();
    }

    ctx.fillStyle = "#18211e";
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.lineWidth = 2;
    for (const obstacle of obstacles) {
      roundRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, 8);
      ctx.fill();
      ctx.stroke();
    }

    for (const b of bullets) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fillStyle = b.owner === "player" ? "#d7efe2" : "#f0b65a";
      ctx.fill();
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 16;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    drawTank(player);
    enemies.forEach(drawTank);

    for (const s of sparks) {
      ctx.globalAlpha = clamp(s.life * 2.2, 0, 1);
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
      ctx.globalAlpha = 1;
    }

    const origin = tankAimOrigin(player);
    ctx.strokeStyle = "rgba(47,177,114,0.42)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(pointer.x, pointer.y);
    ctx.stroke();
  }

  function update(dt) {
    player.reload = Math.max(0, player.reload - dt);
    if (player.charging) player.charge = clamp(player.charge + dt * 0.85, 0, 1);
    for (const enemy of enemies) {
      enemy.reload = Math.max(0, enemy.reload - dt);
      if (enemy.charging) enemy.charge = clamp(enemy.charge + dt * 0.55, 0, 1);
    }

    updatePlayer(dt);
    updateAi(dt);
    updateBullets(dt);
    updateSparks(dt);

    playerScoreEl.textContent = String(playerScore);
    aiScoreEl.textContent = String(aiScore);
    chargeMeter.value = player.charge;
    armorMeter.value = Math.max(0, player.armor);
  }

  function frame(now) {
    const dt = Math.min(0.033, (now - lastTime) / 1000);
    lastTime = now;
    fpsAvg = fpsAvg * 0.94 + (1 / Math.max(dt, 0.001)) * 0.06;
    fpsEl.textContent = String(Math.round(fpsAvg));
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  function unlockAudio() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    audioContext.resume();
    playTone(440, 0.08, "sine", 0.035);
    audioButton.textContent = "Audio on";
  }

  window.addEventListener("keydown", (event) => {
    keys.add(event.code);
    if (event.code === "Space") event.preventDefault();
  });

  window.addEventListener("keyup", (event) => {
    keys.delete(event.code);
    if (event.code === "Space") releaseCharge(player);
  });

  canvas.addEventListener("pointermove", (event) => {
    Object.assign(pointer, canvasPoint(event));
  });
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    Object.assign(pointer, canvasPoint(event), { down: true });
    unlockAudio();
  });
  canvas.addEventListener("pointerup", () => {
    pointer.down = false;
  });
  canvas.addEventListener("pointercancel", () => {
    pointer.down = false;
  });

  moveStick.addEventListener("pointerdown", (event) => {
    moveStick.setPointerCapture(event.pointerId);
    touchMove.active = true;
  });
  moveStick.addEventListener("pointermove", (event) => {
    if (!touchMove.active) return;
    const rect = moveStick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    touchMove.x = clamp((event.clientX - cx) / (rect.width * 0.38), -1, 1);
    touchMove.y = clamp((event.clientY - cy) / (rect.height * 0.38), -1, 1);
  });
  moveStick.addEventListener("pointerup", () => {
    touchMove.active = false;
    touchMove.x = 0;
    touchMove.y = 0;
  });
  moveStick.addEventListener("pointercancel", () => {
    touchMove.active = false;
    touchMove.x = 0;
    touchMove.y = 0;
  });

  firePad.addEventListener("pointerdown", () => {
    touchFire.active = true;
    unlockAudio();
  });
  firePad.addEventListener("pointerup", () => {
    touchFire.active = false;
  });
  firePad.addEventListener("pointercancel", () => {
    touchFire.active = false;
  });

  window.addEventListener("gamepadconnected", (event) => {
    gamepadIndex = event.gamepad.index;
    inputStatus.textContent = event.gamepad.id.slice(0, 28);
  });

  audioButton.addEventListener("click", unlockAudio);
  resetButton.addEventListener("click", resetGame);

  requestAnimationFrame(frame);
})();
