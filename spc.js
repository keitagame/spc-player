// ============================================================================
// Ultra Hi-Fi SPC Player (High-Res Audio Engine)
// ============================================================================

// ----------------------------------------------------------------------------
// 1. 高音質オーディオエフェクト & 補間モジュール
// ----------------------------------------------------------------------------
const GAUSS_TABLE = [
  0x000, 0x000, 0x001, 0x002, 0x003, 0x005, 0x008, 0x00b,
  0x00e, 0x012, 0x016, 0x01a, 0x01e, 0x023, 0x028, 0x02e,
  0x034, 0x03a, 0x040, 0x047, 0x04e, 0x056, 0x05e, 0x066,
  0x06f, 0x078, 0x082, 0x08c, 0x097, 0x0a2, 0x0ad, 0x0b9,
  0x0c5, 0x0d1, 0x0de, 0x0eb, 0x0f8, 0x106, 0x114, 0x122,
  0x131, 0x140, 0x150, 0x160, 0x171, 0x182, 0x194, 0x1a6,
  0x1b9, 0x1cc, 0x1df, 0x1f3, 0x207, 0x21c, 0x231, 0x246,
  0x25c, 0x272, 0x289, 0x2a0, 0x2b7, 0x2cf, 0x2e7, 0x300,
  0x319, 0x332, 0x34b, 0x365, 0x37f, 0x399, 0x3b3, 0x3cd,
  0x3e7, 0x402, 0x41c, 0x436, 0x451, 0x46b, 0x485, 0x4a0,
  0x4ba, 0x4d4, 0x4ee, 0x507, 0x521, 0x53a, 0x553, 0x56c,
  0x585, 0x59d, 0x5b5, 0x5cd, 0x5e5, 0x5fc, 0x613, 0x62a,
  0x640, 0x656, 0x66b, 0x680, 0x695, 0x6a9, 0x6bd, 0x6d1,
  0x6e4, 0x6f7, 0x709, 0x71b, 0x72c, 0x73d, 0x74e, 0x75e,
  0x76d, 0x77c, 0x78a, 0x798, 0x7a5, 0x7b2, 0x7be, 0x7ca,
  0x7d5, 0x7e0, 0x7ea, 0x7f3, 0x7fc, 0x804, 0x80b, 0x812,
  0x818, 0x81d, 0x822, 0x826, 0x829, 0x82c, 0x82e, 0x82f,
];
// 修正前: return (p0 * g0 + p1 * g1 + p2 * g2 + p3 * g3) >> 11;
// 修正後:
function gaussInterpolate(p0, p1, p2, p3, t) {
  const idx = Math.floor(t * 255);
  const g3 = GAUSS_TABLE[idx >> 1];
  const g2 = GAUSS_TABLE[(511 - idx) >> 1];
  const g1 = GAUSS_TABLE[(255 + idx) >> 1];
  const g0 = GAUSS_TABLE[(255 - idx) >> 1];
  return (p0 * g0 + p1 * g1 + p2 * g2 + p3 * g3) / 2048;
}
/**
 * 4点キュービック (Hermite) 補間関数
 * エイリアシングノイズを極限までカットし、ピッチ変更時の音を滑らかにします。
 */
function cubicInterpolate(p0, p1, p2, p3, t) {
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
  const c = -0.5 * p0 + 0.5 * p2;
  const d = p1;
  return a * t * t * t + b * t * t + c * t + d;
}

/**
 * 超高域エキサイター (Harmonic Exciter)
 * BRR圧縮や32kHz制限で失われた10kHz〜20kHzの倍音成分を疑似生成して音の空気感・輝きを復元します。
 */
class HighFreqExciter {
  constructor(sampleRate = 48000) {
    this.hpL = 0; this.hpR = 0;
    this.lpL = 0; this.lpR = 0;
    const rcHp = 1.0 / (2 * Math.PI * 6000);
    const dt = 1.0 / sampleRate;
    this.alpha = dt / (rcHp + dt);
    const rcLp = 1.0 / (2 * Math.PI * 14000);
    this.beta = dt / (rcLp + dt);
  }

  process(l, r, drive = 1.1, mix = 0.12) {
    this.hpL += this.alpha * (l - this.hpL);
    this.hpR += this.alpha * (r - this.hpR);

    const highL = (l - this.hpL) * drive;
    const highR = (r - this.hpR) * drive;

    const satL = Math.sin(Math.max(-1.57, Math.min(1.57, highL)));
    const satR = Math.sin(Math.max(-1.57, Math.min(1.57, highR)));

    this.lpL += this.beta * (satL - this.lpL);
    this.lpR += this.beta * (satR - this.lpR);

    return [l + this.lpL * mix, r + this.lpR * mix];
  }
}

/**
 * ステレオサウンドステージ拡張器 (Soundstage Expander)
 * モノラル寄りの定位感を自然に左右・奥行きへ広げます。
 */
class StereoExpander {
  constructor(sampleRate = 48000) {
    this.lpL = 0; this.lpR = 0;
    const dt = 1.0 / sampleRate;
    const rc = 1.0 / (2 * Math.PI * 200);
    this.alpha = dt / (rc + dt);
  }

  process(l, r, width = 0.20) {
    this.lpL += this.alpha * (l - this.lpL);
    this.lpR += this.alpha * (r - this.lpR);
    const bassMid = (this.lpL + this.lpR) * 0.5;

    const highL = l - this.lpL;
    const highR = r - this.lpR;

    const mid = (highL + highR) * 0.5;
    let side = (highL - highR) * 0.5;
    side *= (1.0 + width);

    return [bassMid + mid + side, bassMid + mid - side];
  }
}
/**
 * クリーン・ソフトリミッター
 * 実機のMath.tanhによる極端な音の潰れ（飽和歪み）を防ぎ、透明感のある広いダイナミックレンジを保ちます。
 */
function cleanSoftLimit(sample) {
  const threshold = 0.82;
  const abs = Math.abs(sample);
  if (abs < threshold) return sample;
  const sign = Math.sign(sample);
  const a = abs - threshold;
  return sign * (threshold + (1 - threshold) * Math.tanh(a / (1 - threshold)));
}


// ============================================================================
// 2. SPC700 CPU エミュレータ (標準実装)
// ============================================================================
class SPC700 {
  constructor(dsp) {
    this.dsp = dsp;
    this.ram = new Uint8Array(0x10000);

    this.A = 0; this.X = 0; this.Y = 0; this.SP = 0; this.PC = 0;
    this.flagN = 0; this.flagV = 0; this.flagP = 0; this.flagB = 0;
    this.flagH = 0; this.flagI = 0; this.flagZ = 0; this.flagC = 0;

    this.ioPort = new Uint8Array(4);
    this.ioIn = new Uint8Array(4);
    this.ioOut = new Uint8Array(4);
    this.timerEnable = [0, 0, 0];
    this.timerTarget = [0, 0, 0];
    this.timerCounter = [0, 0, 0];
    this.timerOut = [0, 0, 0];
    this.cycles = 0;
    
    this._buildOpTable();
  }

  read(addr) {
    addr &= 0xffff;
    switch (addr) {
      case 0xf2: return this.dsp.regAddr;
      case 0xf3: return this.dsp.read(this.dsp.regAddr);
      case 0xf4: case 0xf5: case 0xf6: case 0xf7: return this.ioIn[addr - 0xf4];
      case 0xfd: return this.readTimerOut(0);
      case 0xfe: return this.readTimerOut(1);
      case 0xff: return this.readTimerOut(2);
      default: return this.ram[addr];
    }
  }

  write(addr, val) {
    addr &= 0xffff; val &= 0xff;
    switch (addr) {
      case 0xf1:
        if (val & 0x10) { this.ioPort[0] = 0; this.ioPort[1] = 0; }
        if (val & 0x20) { this.ioPort[2] = 0; this.ioPort[3] = 0; }
        for (let t = 0; t < 3; t++) {
          const en = (val >> t) & 1;
          if (en && !this.timerEnable[t]) {
            this.timerCounter[t] = 0;
            this.timerOut[t] = 0;
          }
          this.timerEnable[t] = en;
        }
        this.ram[addr] = val;
        break;
      case 0xf2: this.dsp.regAddr = val; this.ram[addr] = val; break;
      case 0xf3: this.dsp.write(this.dsp.regAddr, val); this.ram[addr] = val; break;
      case 0xf4: case 0xf5: case 0xf6: case 0xf7: this.ioOut[addr - 0xf4] = val; this.ram[addr] = val; break;
      case 0xfa: this.timerTarget[0] = val === 0 ? 256 : val; this.ram[addr] = val; break;
      case 0xfb: this.timerTarget[1] = val === 0 ? 256 : val; this.ram[addr] = val; break;
      case 0xfc: this.timerTarget[2] = val === 0 ? 256 : val; this.ram[addr] = val; break;
      default: this.ram[addr] = val;
    }
  }

  readTimerOut(t) {
    const v = this.timerOut[t] & 0x0f;
    this.timerOut[t] = 0;
    return v;
  }

  tickTimers(cyc) {
    this._tAccum = this._tAccum || [0, 0, 0];
    const periods = [128, 128, 16];
    for (let t = 0; t < 3; t++) {
      if (!this.timerEnable[t]) continue;
      this._tAccum[t] += cyc;
      while (this._tAccum[t] >= periods[t]) {
        this._tAccum[t] -= periods[t];
        this.timerCounter[t]++;
        if (this.timerCounter[t] >= this.timerTarget[t]) {
          this.timerCounter[t] = 0;
          this.timerOut[t] = (this.timerOut[t] + 1) & 0x0f;
        }
      }
    }
  }

  getPSW() {
    return (this.flagN << 7) | (this.flagV << 6) | (this.flagP << 5) |
           (this.flagB << 4) | (this.flagH << 3) | (this.flagI << 2) |
           (this.flagZ << 1) | (this.flagC);
  }

  setPSW(v) {
    this.flagN = (v >> 7) & 1; this.flagV = (v >> 6) & 1;
    this.flagP = (v >> 5) & 1; this.flagB = (v >> 4) & 1;
    this.flagH = (v >> 3) & 1; this.flagI = (v >> 2) & 1;
    this.flagZ = (v >> 1) & 1; this.flagC = v & 1;
  }

  dpBase() { return this.flagP ? 0x100 : 0x000; }
  setNZ8(v) { v &= 0xff; this.flagZ = v === 0 ? 1 : 0; this.flagN = (v & 0x80) ? 1 : 0; return v; }
  push8(v) { this.ram[0x100 + this.SP] = v & 0xff; this.SP = (this.SP - 1) & 0xff; }
  pop8() { this.SP = (this.SP + 1) & 0xff; return this.ram[0x100 + this.SP]; }
  push16(v) { this.push8((v >> 8) & 0xff); this.push8(v & 0xff); }
  pop16() { const lo = this.pop8(); const hi = this.pop8(); return (hi << 8) | lo; }
  fetch8() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch8(); const hi = this.fetch8(); return (hi << 8) | lo; }
  dp(off) { return (this.dpBase() + off) & 0xffff; }

  adc(a, b, carryIn) {
    const result = a + b + carryIn;
    this.flagH = ((a & 0xf) + (b & 0xf) + carryIn) > 0xf ? 1 : 0;
    this.flagC = result > 0xff ? 1 : 0;
    const r8 = result & 0xff;
    this.flagV = (~(a ^ b) & (a ^ r8) & 0x80) ? 1 : 0;
    this.setNZ8(r8);
    return r8;
  }

  sbc(a, b, carryIn) { return this.adc(a, (~b) & 0xff, carryIn); }

  step() {
    const op = this.fetch8();
    const cyc = this._exec(op);
    this.cycles += cyc;
    this.tickTimers(cyc);
    return cyc;
  }

  _exec(op) {
    const fn = this.opTable[op];
    if (!fn) { console.error("UNKNOWN OPCODE", op.toString(16).padStart(2, "0")); return 2; }
    return fn.call(this);
  }

  _branch(cond, disp) {
    if (cond) {
      const s = disp & 0x80 ? disp - 256 : disp;
      this.PC = (this.PC + s) & 0xffff;
      return 2;
    }
    return 0;
  }

  _buildOpTable() {
    const T = new Array(256).fill(null);
    const rd = (addr) => this.read(addr);
    const wr = (addr, v) => this.write(addr, v);

    T[0x00] = function () { return 2; };
    T[0xE8] = function () { this.A = this.setNZ8(this.fetch8()); return 2; };
    T[0xCD] = function () { this.X = this.setNZ8(this.fetch8()); return 2; };
    T[0x8D] = function () { this.Y = this.setNZ8(this.fetch8()); return 2; };

    T[0x7D] = function () { this.A = this.setNZ8(this.X); return 2; };
    T[0xDD] = function () { this.A = this.setNZ8(this.Y); return 2; };
    T[0x5D] = function () { this.X = this.setNZ8(this.A); return 2; };
    T[0xFD] = function () { this.Y = this.setNZ8(this.A); return 2; };
    T[0x9D] = function () { this.X = this.setNZ8(this.SP); return 2; };
    T[0xBD] = function () { this.SP = this.X; return 2; };

    T[0xC4] = function () { wr(this.dp(this.fetch8()), this.A); return 4; };
    T[0xE4] = function () { this.A = this.setNZ8(rd(this.dp(this.fetch8()))); return 3; };
    T[0xD8] = function () { wr(this.dp(this.fetch8()), this.X); return 4; };
    T[0xF8] = function () { this.X = this.setNZ8(rd(this.dp(this.fetch8()))); return 3; };
    T[0xCB] = function () { wr(this.dp(this.fetch8()), this.Y); return 4; };
    T[0xEB] = function () { this.Y = this.setNZ8(rd(this.dp(this.fetch8()))); return 3; };

    T[0xD4] = function () { wr(this.dp((this.fetch8() + this.X) & 0xff), this.A); return 5; };
    T[0xF4] = function () { this.A = this.setNZ8(rd(this.dp((this.fetch8() + this.X) & 0xff))); return 4; };
    T[0xD9] = function () { wr(this.dp((this.fetch8() + this.Y) & 0xff), this.X); return 5; };
    T[0xF9] = function () { this.X = this.setNZ8(rd(this.dp((this.fetch8() + this.Y) & 0xff))); return 4; };
    T[0xDB] = function () { wr(this.dp((this.fetch8() + this.X) & 0xff), this.Y); return 5; };
    T[0xFB] = function () { this.Y = this.setNZ8(rd(this.dp((this.fetch8() + this.X) & 0xff))); return 4; };

    T[0xC5] = function () { wr(this.fetch16(), this.A); return 5; };
    T[0xE5] = function () { this.A = this.setNZ8(rd(this.fetch16())); return 4; };
    T[0xC9] = function () { wr(this.fetch16(), this.X); return 5; };
    T[0xE9] = function () { this.X = this.setNZ8(rd(this.fetch16())); return 4; };
    T[0xCC] = function () { wr(this.fetch16(), this.Y); return 5; };
    T[0xEC] = function () { this.Y = this.setNZ8(rd(this.fetch16())); return 4; };

    T[0xD5] = function () { wr((this.fetch16() + this.X) & 0xffff, this.A); return 6; };
    T[0xD6] = function () { wr((this.fetch16() + this.Y) & 0xffff, this.A); return 6; };
    T[0xF5] = function () { this.A = this.setNZ8(rd((this.fetch16() + this.X) & 0xffff)); return 5; };
    T[0xF6] = function () { this.A = this.setNZ8(rd((this.fetch16() + this.Y) & 0xffff)); return 5; };

    T[0xC6] = function () { wr(this.dp(this.X), this.A); return 4; };
    T[0xE6] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); return 3; };
    T[0xAF] = function () { wr(this.dp(this.X), this.A); this.X = (this.X + 1) & 0xff; return 4; };
    T[0xBF] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); this.X = (this.X + 1) & 0xff; return 4; };

    T[0xC7] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8); wr(a, this.A); return 7; };
    T[0xE7] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8); this.A = this.setNZ8(rd(a)); return 6; };
    T[0xD7] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8); wr((base + this.Y) & 0xffff, this.A); return 7; };
    T[0xF7] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8); this.A = this.setNZ8(rd((base + this.Y) & 0xffff)); return 6; };

    T[0xFA] = function () { const src = this.dp(this.fetch8()); wr(this.dp(this.fetch8()), rd(src)); return 5; };
    T[0x8F] = function () { const v = this.fetch8(); wr(this.dp(this.fetch8()), v); return 5; };

    T[0xBA] = function () {
      const a = this.dp(this.fetch8()); const lo = rd(a); const hi = rd((a + 1) & 0xffff);
      this.A = lo; this.Y = hi; const w = (hi << 8) | lo;
      this.flagZ = w === 0 ? 1 : 0; this.flagN = (hi & 0x80) ? 1 : 0;
      return 5;
    };
    T[0xDA] = function () { const a = this.dp(this.fetch8()); wr(a, this.A); wr((a + 1) & 0xffff, this.Y); return 5; };
    T[0x3A] = function () { const a = this.dp(this.fetch8()); let w = (rd(a) | (rd((a + 1) & 0xffff) << 8)) + 1 & 0xffff; wr(a, w & 0xff); wr((a + 1) & 0xffff, (w >> 8) & 0xff); this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0; return 6; };
    T[0x1A] = function () { const a = this.dp(this.fetch8()); let w = (rd(a) | (rd((a + 1) & 0xffff) << 8)) - 1 & 0xffff; wr(a, w & 0xff); wr((a + 1) & 0xffff, (w >> 8) & 0xff); this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0; return 6; };
    T[0x7A] = function () {
      const a = this.dp(this.fetch8()); const ya = (this.Y << 8) | this.A; const m = (rd(a) | (rd((a + 1) & 0xffff) << 8));
      const result = ya + m; this.flagC = result > 0xffff ? 1 : 0; const r16 = result & 0xffff;
      this.flagV = (~(ya ^ m) & (ya ^ r16) & 0x8000) ? 1 : 0;
      this.flagH = (((ya & 0xfff) + (m & 0xfff)) > 0xfff) ? 1 : 0;
      this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
      this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
      return 5;
    };
    T[0x9A] = function () {
      const a = this.dp(this.fetch8()); const ya = (this.Y << 8) | this.A; const m = (rd(a) | (rd((a + 1) & 0xffff) << 8));
      const mInv = (~m) & 0xffff; const result = ya + mInv + 1; this.flagC = result > 0xffff ? 1 : 0; const r16 = result & 0xffff;
      this.flagV = (~(ya ^ mInv) & (ya ^ r16) & 0x8000) ? 1 : 0;
      this.flagH = (((ya & 0xfff) + (mInv & 0xfff) + 1) > 0xfff) ? 1 : 0;
      this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
      this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
      return 5;
    };
    T[0x5A] = function () {
      const a = this.dp(this.fetch8()); const ya = (this.Y << 8) | this.A; const m = (rd(a) | (rd((a + 1) & 0xffff) << 8));
      const result = (ya - m) & 0xffff; this.flagC = ya >= m ? 1 : 0; this.flagZ = result === 0 ? 1 : 0; this.flagN = (result & 0x8000) ? 1 : 0;
      return 4;
    };

    T[0x08] = function () { this.A = this.setNZ8(this.A | this.fetch8()); return 2; };
    T[0x28] = function () { this.A = this.setNZ8(this.A & this.fetch8()); return 2; };
    T[0x48] = function () { this.A = this.setNZ8(this.A ^ this.fetch8()); return 2; };
    T[0x68] = function () { const v = this.fetch8(); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 2; };
    T[0x88] = function () { this.A = this.adc(this.A, this.fetch8(), this.flagC); return 2; };
    T[0xA8] = function () { this.A = this.sbc(this.A, this.fetch8(), this.flagC); return 2; };

    T[0x04] = function () { this.A = this.setNZ8(this.A | rd(this.dp(this.fetch8()))); return 3; };
    T[0x24] = function () { this.A = this.setNZ8(this.A & rd(this.dp(this.fetch8()))); return 3; };
    T[0x44] = function () { this.A = this.setNZ8(this.A ^ rd(this.dp(this.fetch8()))); return 3; };
    T[0x64] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
    T[0x84] = function () { this.A = this.adc(this.A, rd(this.dp(this.fetch8())), this.flagC); return 3; };
    T[0xA4] = function () { this.A = this.sbc(this.A, rd(this.dp(this.fetch8())), this.flagC); return 3; };

    T[0x14] = function () { this.A = this.setNZ8(this.A | rd(this.dp((this.fetch8() + this.X) & 0xff))); return 4; };
    T[0x34] = function () { this.A = this.setNZ8(this.A & rd(this.dp((this.fetch8() + this.X) & 0xff))); return 4; };
    T[0x54] = function () { this.A = this.setNZ8(this.A ^ rd(this.dp((this.fetch8() + this.X) & 0xff))); return 4; };
    T[0x74] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
    T[0x94] = function () { this.A = this.adc(this.A, rd(this.dp((this.fetch8() + this.X) & 0xff)), this.flagC); return 4; };
    T[0xB4] = function () { this.A = this.sbc(this.A, rd(this.dp((this.fetch8() + this.X) & 0xff)), this.flagC); return 4; };

    T[0x05] = function () { this.A = this.setNZ8(this.A | rd(this.fetch16())); return 4; };
    T[0x25] = function () { this.A = this.setNZ8(this.A & rd(this.fetch16())); return 4; };
    T[0x45] = function () { this.A = this.setNZ8(this.A ^ rd(this.fetch16())); return 4; };
    T[0x65] = function () { const v = rd(this.fetch16()); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
    T[0x85] = function () { this.A = this.adc(this.A, rd(this.fetch16()), this.flagC); return 4; };
    T[0xA5] = function () { this.A = this.sbc(this.A, rd(this.fetch16()), this.flagC); return 4; };

    T[0x15] = function () { this.A = this.setNZ8(this.A | rd((this.fetch16() + this.X) & 0xffff)); return 5; };
    T[0x16] = function () { this.A = this.setNZ8(this.A | rd((this.fetch16() + this.Y) & 0xffff)); return 5; };
    T[0x35] = function () { this.A = this.setNZ8(this.A & rd((this.fetch16() + this.X) & 0xffff)); return 5; };
    T[0x36] = function () { this.A = this.setNZ8(this.A & rd((this.fetch16() + this.Y) & 0xffff)); return 5; };
    T[0x55] = function () { this.A = this.setNZ8(this.A ^ rd((this.fetch16() + this.X) & 0xffff)); return 5; };
    T[0x56] = function () { this.A = this.setNZ8(this.A ^ rd((this.fetch16() + this.Y) & 0xffff)); return 5; };
    T[0x75] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 5; };
    T[0x76] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 5; };
    T[0x95] = function () { this.A = this.adc(this.A, rd((this.fetch16() + this.X) & 0xffff), this.flagC); return 5; };
    T[0x96] = function () { this.A = this.adc(this.A, rd((this.fetch16() + this.Y) & 0xffff), this.flagC); return 5; };
    T[0xB5] = function () { this.A = this.sbc(this.A, rd((this.fetch16() + this.X) & 0xffff), this.flagC); return 5; };
    T[0xB6] = function () { this.A = this.sbc(this.A, rd((this.fetch16() + this.Y) & 0xffff), this.flagC); return 5; };

    T[0x06] = function () { this.A = this.setNZ8(this.A | rd(this.dp(this.X))); return 3; };
    T[0x26] = function () { this.A = this.setNZ8(this.A & rd(this.dp(this.X))); return 3; };
    T[0x46] = function () { this.A = this.setNZ8(this.A ^ rd(this.dp(this.X))); return 3; };
    T[0x66] = function () { const v = rd(this.dp(this.X)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
    T[0x86] = function () { this.A = this.adc(this.A, rd(this.dp(this.X)), this.flagC); return 3; };
    T[0xA6] = function () { this.A = this.sbc(this.A, rd(this.dp(this.X)), this.flagC); return 3; };

    T[0x07] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.setNZ8(this.A | rd(a)); return 6; };
    T[0x27] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.setNZ8(this.A & rd(a)); return 6; };
    T[0x47] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.setNZ8(this.A ^ rd(a)); return 6; };
    T[0x67] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
    T[0x87] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.adc(this.A, rd(a), this.flagC); return 6; };
    T[0xA7] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.sbc(this.A, rd(a), this.flagC); return 6; };

    T[0x17] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.setNZ8(this.A | rd((base+this.Y)&0xffff)); return 6; };
    T[0x37] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.setNZ8(this.A & rd((base+this.Y)&0xffff)); return 6; };
    T[0x57] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.setNZ8(this.A ^ rd((base+this.Y)&0xffff)); return 6; };
    T[0x77] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
    T[0x97] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.adc(this.A, rd((base+this.Y)&0xffff), this.flagC); return 6; };
    T[0xB7] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); this.A = this.sbc(this.A, rd((base+this.Y)&0xffff), this.flagC); return 6; };

    T[0x09] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) | rd(src))); return 6; };
    T[0x29] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) & rd(src))); return 6; };
    T[0x49] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) ^ rd(src))); return 6; };
    T[0x69] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); const a=rd(dst), b=rd(src); this.flagC = a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 6; };
    T[0x89] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.adc(rd(dst), rd(src), this.flagC)); return 6; };
    T[0xA9] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.sbc(rd(dst), rd(src), this.flagC)); return 6; };

    T[0x18] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) | v)); return 5; };
    T[0x38] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) & v)); return 5; };
    T[0x58] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) ^ v)); return 5; };
    T[0x78] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); const m = rd(a); this.flagC = m>=v?1:0; this.setNZ8((m-v)&0x1ff); return 5; };
    T[0x98] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.adc(rd(a), v, this.flagC)); return 5; };
    T[0xB8] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.sbc(rd(a), v, this.flagC)); return 5; };

    T[0x19] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) | rd(srcA))); return 5; };
    T[0x39] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) & rd(srcA))); return 5; };
    T[0x59] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) ^ rd(srcA))); return 5; };
    T[0x79] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); const a=rd(dstA), b=rd(srcA); this.flagC=a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 5; };
    T[0x99] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.adc(rd(dstA), rd(srcA), this.flagC)); return 5; };
    T[0xB9] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.sbc(rd(dstA), rd(srcA), this.flagC)); return 5; };

    T[0xC8] = function () { const v = this.fetch8(); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 2; };
    T[0xAD] = function () { const v = this.fetch8(); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 2; };
    T[0x3E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 3; };
    T[0x7E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 3; };
    T[0x1E] = function () { const v = rd(this.fetch16()); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 4; };
    T[0x5E] = function () { const v = rd(this.fetch16()); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 4; };

    T[0xBC] = function () { this.A = this.setNZ8(this.A + 1); return 2; };
    T[0x9C] = function () { this.A = this.setNZ8(this.A - 1); return 2; };
    T[0x3D] = function () { this.X = this.setNZ8(this.X + 1); return 2; };
    T[0x1D] = function () { this.X = this.setNZ8(this.X - 1); return 2; };
    T[0xFC] = function () { this.Y = this.setNZ8(this.Y + 1); return 2; };
    T[0xDC] = function () { this.Y = this.setNZ8(this.Y - 1); return 2; };

    T[0xAB] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) + 1)); return 4; };
    T[0x8B] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) - 1)); return 4; };
    T[0xBB] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
    T[0x9B] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) - 1)); return 5; };
    T[0xAC] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
    T[0x8C] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) - 1)); return 5; };

    const asl = (v) => { const c = (v & 0x80) ? 1 : 0; const r = (v << 1) & 0xff; this.flagC = c; return this.setNZ8(r); };
    const lsr = (v) => { const c = v & 1; const r = (v >> 1) & 0xff; this.flagC = c; return this.setNZ8(r); };
    const rol = (v) => { const c = (v & 0x80) ? 1 : 0; const r = ((v << 1) | this.flagC) & 0xff; this.flagC = c; return this.setNZ8(r); };
    const ror = (v) => { const c = v & 1; const r = ((v >> 1) | (this.flagC << 7)) & 0xff; this.flagC = c; return this.setNZ8(r); };

    T[0x1C] = function () { this.A = asl(this.A); return 2; };
    T[0x0B] = function () { const a=this.dp(this.fetch8()); wr(a, asl(rd(a))); return 4; };
    T[0x1B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, asl(rd(a))); return 5; };
    T[0x0C] = function () { const a=this.fetch16(); wr(a, asl(rd(a))); return 5; };

    T[0x5C] = function () { this.A = lsr(this.A); return 2; };
    T[0x4B] = function () { const a=this.dp(this.fetch8()); wr(a, lsr(rd(a))); return 4; };
    T[0x5B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, lsr(rd(a))); return 5; };
    T[0x4C] = function () { const a=this.fetch16(); wr(a, lsr(rd(a))); return 5; };

    T[0x3C] = function () { this.A = rol(this.A); return 2; };
    T[0x2B] = function () { const a=this.dp(this.fetch8()); wr(a, rol(rd(a))); return 4; };
    T[0x3B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, rol(rd(a))); return 5; };
    T[0x2C] = function () { const a=this.fetch16(); wr(a, rol(rd(a))); return 5; };

    T[0x7C] = function () { this.A = ror(this.A); return 2; };
    T[0x6B] = function () { const a=this.dp(this.fetch8()); wr(a, ror(rd(a))); return 4; };
    T[0x7B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, ror(rd(a))); return 5; };
    T[0x6C] = function () { const a=this.fetch16(); wr(a, ror(rd(a))); return 5; };

    T[0x9F] = function () { this.A = this.setNZ8(((this.A << 4) | (this.A >> 4)) & 0xff); return 5; };

    T[0xCF] = function () {
      const r = (this.Y & 0xff) * (this.A & 0xff);
      this.A = r & 0xff; this.Y = (r >> 8) & 0xff;
      this.setNZ8(this.Y); return 9;
    };
    T[0x9E] = function () {
      let ya = (this.Y << 8) | this.A; const x = this.X;
      if (x === 0) {
        this.A = 0xff; this.Y = 0xff; this.flagV = 1; this.flagH = 1; this.setNZ8(this.A); return 12;
      }
      this.flagH = ((this.Y & 0xf) >= (x & 0xf)) ? 1 : 0;
      const quotient = Math.floor(ya / x); const remainder = ya % x;
      this.flagV = quotient > 0xff ? 1 : 0;
      this.A = quotient & 0xff; this.Y = remainder & 0xff;
      this.setNZ8(this.A); return 12;
    };

    T[0xDF] = function () {
      let a = this.A;
      if (this.flagC || a > 0x99) { a = (a + 0x60) & 0xff; this.flagC = 1; }
      if (this.flagH || (a & 0x0f) > 9) { a = (a + 0x06) & 0xff; }
      this.A = this.setNZ8(a); return 3;
    };
    T[0xBE] = function () {
      let a = this.A;
      if (!this.flagC || a > 0x99) { a = (a - 0x60) & 0xff; this.flagC = 0; }
      if (!this.flagH || (a & 0x0f) > 9) { a = (a - 0x06) & 0xff; }
      this.A = this.setNZ8(a); return 3;
    };

    T[0x60] = function () { this.flagC = 0; return 2; };
    T[0x80] = function () { this.flagC = 1; return 2; };
    T[0xED] = function () { this.flagC = this.flagC ^ 1; return 3; };
    T[0x20] = function () { this.flagP = 0; return 2; };
    T[0x40] = function () { this.flagP = 1; return 2; };
    T[0xE0] = function () { this.flagV = 0; this.flagH = 0; return 2; };
    T[0xA0] = function () { this.flagI = 1; return 3; };
    T[0xC0] = function () { this.flagI = 0; return 3; };

    T[0x2D] = function () { this.push8(this.A); return 4; };
    T[0x4D] = function () { this.push8(this.X); return 4; };
    T[0x6D] = function () { this.push8(this.Y); return 4; };
    T[0x0D] = function () { this.push8(this.getPSW()); return 4; };
    T[0xAE] = function () { this.A = this.pop8(); return 4; };
    T[0xCE] = function () { this.X = this.pop8(); return 4; };
    T[0xEE] = function () { this.Y = this.pop8(); return 4; };
    T[0x8E] = function () { this.setPSW(this.pop8()); return 4; };

    T[0x2F] = function () { const d = this.fetch8(); const s=d&0x80?d-256:d; this.PC=(this.PC+s)&0xffff; return 4; };
    T[0xF0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===1, d); };
    T[0xD0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===0, d); };
    T[0xB0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===1, d); };
    T[0x90] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===0, d); };
    T[0x70] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===1, d); };
    T[0x50] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===0, d); };
    T[0x30] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===1, d); };
    T[0x10] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===0, d); };

    for (let bit = 0; bit < 8; bit++) {
      const opSet = 0x03 | (bit << 5); const opClr = 0x13 | (bit << 5);
      T[opSet] = function () { const a = this.dp(this.fetch8()); const d = this.fetch8(); const v = rd(a); return 5 + this._branch(((v >> bit) & 1) === 1, d); };
      T[opClr] = function () { const a = this.dp(this.fetch8()); const d = this.fetch8(); const v = rd(a); return 5 + this._branch(((v >> bit) & 1) === 0, d); };
    }

    T[0x2E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); return 5 + this._branch(this.A!==rd(a), d); };
    T[0xDE] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); const d=this.fetch8(); return 6 + this._branch(this.A!==rd(a), d); };

    T[0xFE] = function () { const d=this.fetch8(); this.Y=(this.Y-1)&0xff; return 4 + this._branch(this.Y!==0, d); };
    T[0x6E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); let v=(rd(a)-1)&0xff; wr(a,v); return 5 + this._branch(v!==0, d); };

    T[0x5F] = function () { this.PC = this.fetch16(); return 3; };
    T[0x1F] = function () { const base = this.fetch16(); const ptr=(base+this.X)&0xffff; this.PC = rd(ptr) | (rd((ptr+1)&0xffff)<<8); return 6; };

    T[0x3F] = function () { const a = this.fetch16(); this.push16(this.PC); this.PC = a; return 8; };
    T[0x4F] = function () { const a = 0xFF00 | this.fetch8(); this.push16(this.PC); this.PC = a; return 6; };
    for (let n = 0; n < 16; n++) {
      const op = 0x01 | (n << 4);
      T[op] = function () {
        const vecAddr = 0xFFDE - n * 2;
        const target = rd(vecAddr) | (rd((vecAddr + 1) & 0xffff) << 8);
        this.push16(this.PC); this.PC = target; return 8;
      };
    }

    T[0x6F] = function () { this.PC = this.pop16(); return 5; };
    T[0x7F] = function () { this.setPSW(this.pop8()); this.PC = this.pop16(); return 6; };

    T[0x0F] = function () {
      this.push16(this.PC); this.push8(this.getPSW());
      this.flagB = 1; this.flagI = 0;
      this.PC = rd(0xFFDE) | (rd(0xFFDF) << 8); return 8;
    };

    T[0xEF] = function () { this._stopped = true; return 3; };
    T[0xFF] = function () { this._stopped = true; return 3; };

    T[0xAA] = function () { const w = this.fetch16(); this.flagC = (rd(w & 0x1fff) >> ((w >> 13) & 7)) & 1; return 4; };
    T[0xCA] = function () {
      const w = this.fetch16(); const addr = w & 0x1fff; const bit = (w >> 13) & 7;
      let v = rd(addr); if (this.flagC) v |= (1 << bit); else v &= ~(1 << bit);
      wr(addr, v & 0xff); return 6;
    };

    T[0x4A] = function () { const w=this.fetch16(); this.flagC &= (rd(w&0x1fff)>>((w>>13)&7))&1; return 4; };
    T[0x6A] = function () { const w=this.fetch16(); this.flagC &= ((rd(w&0x1fff)>>((w>>13)&7))&1)^1; return 4; };
    T[0x0A] = function () { const w=this.fetch16(); this.flagC |= (rd(w&0x1fff)>>((w>>13)&7))&1; return 5; };
    T[0x2A] = function () { const w=this.fetch16(); this.flagC |= ((rd(w&0x1fff)>>((w>>13)&7))&1)^1; return 5; };
    T[0x8A] = function () { const w=this.fetch16(); this.flagC ^= (rd(w&0x1fff)>>((w>>13)&7))&1; return 5; };

    T[0xEA] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; wr(addr, rd(addr)^(1<<bit)); return 5; };

    for (let bit = 0; bit < 8; bit++) {
      const opSet = 0x02 | (bit << 5); const opClr = 0x12 | (bit << 5);
      T[opSet] = function () { const a=this.dp(this.fetch8()); wr(a, rd(a) | (1<<bit)); return 4; };
      T[opClr] = function () { const a=this.dp(this.fetch8()); wr(a, rd(a) & ~(1<<bit)); return 4; };
    }

    T[0x0E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v | this.A); return 6; };
    T[0x4E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v & (~this.A & 0xff)); return 6; };

    this.opTable = T;
  }
}

if (typeof module !== 'undefined') module.exports = { SPC700 };


// ============================================================================
// 3. 高音質化 SNES DSP (S-DSP) エミュレータ
// ============================================================================
const SDSP_RATE = 32000;
const COUNTER_RATES = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192,
  160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1
];

class DSP {
  constructor(ram) {
    this.ram = ram;
    this.regs = new Uint8Array(128);
    this.regAddr = 0;

    this.voices = [];
    for (let i = 0; i < 8; i++) {
      this.voices.push({
        brrAddr: 0, brrOffset: 0, pitchCounter: 0,
        history: [0, 0], decodedBlock: new Int16Array(16),
        curBlockHeader: 0, keyOn: false, keyOff: false,
        envMode: 'release', envLevel: 0, loopFlag: false,
        endFlag: false, sampleAddr: 0, outSample: 0,
      });
    }

    this.noiseLFSR = 0x4000;
  }

  reset() {
    this.regs.fill(0);
    this.regAddr = 0;
    for (const v of this.voices) {
      v.pitchCounter = 0; v.envLevel = 0; v.keyOn = false;
      v.keyOff = false; v.envMode = 'release'; v.history = [0, 0];
      v.brrOffset = 16; v.endFlag = false;
    }
  }

  read(addr) { return this.regs[addr & 0x7f]; }
  write(addr, val) {
    addr &= 0x7f; val &= 0xff;
    if (addr === 0x7c) return;
    this.regs[addr] = val;
  }

  volL(v) { return this._s8(this.regs[v * 0x10 + 0x00]); }
  volR(v) { return this._s8(this.regs[v * 0x10 + 0x01]); }
  pitch(v) { return this.regs[v * 0x10 + 0x02] | (this.regs[v * 0x10 + 0x03] << 8); }
  srcn(v) { return this.regs[v * 0x10 + 0x04]; }
  adsr1(v) { return this.regs[v * 0x10 + 0x05]; }
  adsr2(v) { return this.regs[v * 0x10 + 0x06]; }
  gain(v) { return this.regs[v * 0x10 + 0x07]; }

  _s8(v) { return v >= 128 ? v - 256 : v; }

  get kon() { return this.regs[0x4c]; }
  get koff() { return this.regs[0x5c]; }
  get pmon() { return this.regs[0x2d]; }
  get non() { return this.regs[0x3d]; }
  get dir() { return this.regs[0x5d]; }
  get mvolL() { return this._s8(this.regs[0x0c]); }
  get mvolR() { return this._s8(this.regs[0x1c]); }

  getSampleDirEntry(srcn) {
    const base = (this.dir << 8) + srcn * 4;
    const start = this.ram[base] | (this.ram[base + 1] << 8);
    const loop = this.ram[base + 2] | (this.ram[base + 3] << 8);
    return { start, loop };
  }

  decodeBrrBlock(voice, addr) {
    const header = this.ram[addr];
    const range = (header >> 4) & 0x0f;
    const filter = (header >> 2) & 0x03;
    const loopBit = (header >> 1) & 1;
    const endBit = header & 1;

    const out = voice.decodedBlock;
    let h1 = voice.history[0];
    let h2 = voice.history[1];

    for (let i = 0; i < 16; i++) {
      const byteIdx = 1 + (i >> 1);
      const byte = this.ram[(addr + byteIdx) & 0xffff];
      let nibble = (i & 1) === 0 ? (byte >> 4) : (byte & 0x0f);
      if (nibble >= 8) nibble -= 16;

      let sample = (range <= 12) ? ((nibble << range) >> 1) : (nibble < 0 ? -2048 : 0);

      let pred = 0;
      switch (filter) {
        case 0: pred = 0; break;
        case 1: pred = h1 + ((-h1) >> 4); break;
        case 2: pred = h1 * 2 + ((-(h1 * 3)) >> 5) - h2 + (h2 >> 4); break;
        case 3: pred = h1 * 2 + ((-(h1 * 13)) >> 6) - h2 + ((h2 * 3) >> 4); break;
      }
      let s = sample + pred;
      if (s > 32767) s = 32767;
      if (s < -32768) s = -32768;

      out[i] = s;
      h2 = h1; h1 = s;
    }

    voice.history[0] = h1;
    voice.history[1] = h2;
    voice.loopFlag = loopBit === 1;
    voice.endFlag = endBit === 1;
    return endBit === 1;
  }

  stepNoise() {
    let lfsr = this.noiseLFSR;
    const bit = ((lfsr << 14) ^ (lfsr << 13)) & 0x4000;
    lfsr = ((lfsr >> 1) | bit) & 0x7fff;
    this.noiseLFSR = lfsr;
    let v = lfsr & 0x7fff;
    if (v & 0x4000) v -= 0x8000;
    return v;
  }

  stepEnvelope(voice, vIdx) {
    const a1 = this.adsr1(vIdx);
    const a2 = this.adsr2(vIdx);
    const useADSR = (a1 & 0x80) !== 0;

    if (voice.keyOff) voice.envMode = 'release';

    if (voice.envMode === 'release') {
      voice.envLevel -= 8;
      if (voice.envLevel < 0) voice.envLevel = 0;
      return voice.envLevel;
    }

    if (useADSR) {
      const attackRate = (a1 & 0x0f) * 2 + 1;
      const decayRate = ((a1 >> 4) & 0x07) * 2 + 16;
      const sustainRate = a2 & 0x1f;
      const sustainLvl = (((a2 >> 5) & 0x07) + 1) * 256;

      if (voice.envMode === 'attack') {
        if (this._rateFires(attackRate)) {
          voice.envLevel += (attackRate === 31) ? 1024 : 32;
          if (voice.envLevel >= 2047) { voice.envLevel = 2047; voice.envMode = 'decay'; }
        }
      } else if (voice.envMode === 'decay') {
        if (this._rateFires(decayRate)) {
          voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          if (voice.envLevel <= sustainLvl) voice.envMode = 'sustain';
        }
      } else if (voice.envMode === 'sustain') {
        if (sustainRate > 0 && this._rateFires(sustainRate)) {
          voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
        }
      }
    } else {
      const gainVal = this.gain(vIdx);
      if ((gainVal & 0x80) === 0) {
        voice.envLevel = (gainVal & 0x7f) * 16;
      } else {
        const mode = (gainVal >> 5) & 0x03;
        const rate = gainVal & 0x1f;
        if (this._rateFires(rate)) {
          if (mode === 0) voice.envLevel -= 32;
          else if (mode === 1) voice.envLevel += 32;
          else if (mode === 2) voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          else voice.envLevel += (voice.envLevel < 1536) ? 32 : 8;
        }
      }
    }

    if (voice.envLevel < 0) voice.envLevel = 0;
    if (voice.envLevel > 2047) voice.envLevel = 2047;
    return voice.envLevel;
  }

  _rateFires(rateIndex) {
    const period = COUNTER_RATES[rateIndex] || 0;
    if (period === 0) return false;
    this._globalCounter = (this._globalCounter || 0);
    return (this._globalCounter % period) === 0;
  }

  generateSample() {
    this._globalCounter = (this._globalCounter || 0) + 1;

    let mixL = 0, mixR = 0;
    const konReg = this.kon;
    const koffReg = this.koff;

    for (let i = 0; i < 8; i++) {
      const voice = this.voices[i];
      const bit = 1 << i;

      if (konReg & bit) {
        if (!voice._konLatched) {
          this._triggerKeyOn(voice, i);
          voice._konLatched = true;
        }
      } else {
        voice._konLatched = false;
      }
      
      voice.keyOff = !!(koffReg & bit);
      if (voice.envMode === 'off') continue;

      let p = this.pitch(i);
      if (i > 0 && (this.pmon & bit)) {
        const prevOut = this.voices[i - 1].outSample;
        p = Math.floor((p * ((prevOut >> 5) + 1024)) / 1024);
      }
      if (p > 0x3fff) p = 0x3fff;

      if (voice.brrOffset >= 16) {
        if (voice.endFlag) {
          if (voice.loopFlag) {
            voice.brrAddr = this.getSampleDirEntry(this.srcn(i)).loop;
          } else {
            voice.envMode = 'off'; voice.envLevel = 0; continue;
          }
        }
        this.decodeBrrBlock(voice, voice.brrAddr);
        voice.brrOffset = 0;
      }

      // ----------------------------------------------------------------------
      // 高音質改修：2点線形補間から4点キュービック (Hermite) 補間へ向上
      // ----------------------------------------------------------------------
      const idx = voice.brrOffset;
      const block = voice.decodedBlock;
      const p0 = idx > 0 ? block[idx - 1] : block[idx];
      const p1 = block[idx];
      const p2 = idx < 15 ? block[idx + 1] : p1;
      const p3 = idx < 14 ? block[idx + 2] : p2;

      const frac = (voice.pitchCounter & 0xfff) / 0x1000;
      let sample = cubicInterpolate(p0, p1, p2, p3, frac);

      if (this.non & bit) sample = this.stepNoise();

      const env = this.stepEnvelope(voice, i);
      sample = (sample * env) / 2047;
      voice.outSample = sample;

      const vl = this.volL(i) / 128;
      const vr = this.volR(i) / 128;
      mixL += sample * vl;
      mixR += sample * vr;

      voice.pitchCounter += p;
      const advance = voice.pitchCounter >> 12;
      voice.pitchCounter &= 0xfff;
      voice.brrOffset += advance;

      while (voice.brrOffset >= 16) {
        if (voice.endFlag) {
          if (voice.loopFlag) {
            voice.brrAddr = this.getSampleDirEntry(this.srcn(i)).loop;
          } else {
            voice.envMode = 'off'; voice.envLevel = 0; voice.brrOffset = 16; break;
          }
        } else {
          voice.brrAddr = (voice.brrAddr + 9) & 0xffff;
        }
        if (voice.envMode === 'off') break;
        this.decodeBrrBlock(voice, voice.brrAddr);
        voice.brrOffset -= 16;
      }
    }

    let outL = (mixL * this.mvolL) / (128 * 8192);
    let outR = (mixR * this.mvolR) / (128 * 8192);

    return [outL, outR];
  }

  _triggerKeyOn(voice, i) {
    const dirEntry = this.getSampleDirEntry(this.srcn(i));
    voice.brrAddr = dirEntry.start;
    voice.brrOffset = 16;
    voice.pitchCounter = 0;
    voice.history = [0, 0];
    voice.envLevel = 0;
    voice.envMode = 'attack';
    voice.keyOff = false;
    voice.endFlag = false;
    voice.loopFlag = false;
  }
}

if (typeof module !== 'undefined') module.exports = { DSP, SDSP_RATE };


// ============================================================================
// 4. SPC再生エンジン
// ============================================================================
const CPU_CYCLES_PER_SAMPLE = 32;

class SPCEngine {
  constructor() {
    this.dsp = new DSP();
    this.cpu = new SPC700(this.dsp);
    this.dsp.ram = this.cpu.ram;
    this.loaded = false;
    this._cycleAccum = 0;
  }

  loadSPC(parsed) {
    this.cpu.ram.set(parsed.ram);
    this.cpu.A = parsed.a; this.cpu.X = parsed.x; this.cpu.Y = parsed.y;
    this.cpu.SP = parsed.sp; this.cpu.PC = parsed.pc;
    this.cpu.setPSW(parsed.psw);

    this.dsp.reset();
    this.dsp.regs.set(parsed.dspRegs);

    for (const addr of [0xfa, 0xfb, 0xfc, 0xf1]) {
      this.cpu.write(addr, parsed.ram[addr]);
    }
    for (let i = 0; i < 4; i++) {
      this.cpu.ioIn[i] = parsed.ram[0xf4 + i];
      this.cpu.ioOut[i] = parsed.ram[0xf4 + i];
    }
    this.cpu.timerCounter = [0, 0, 0];
    this.cpu.timerOut = new Uint8Array(3);
    this.cpu._tAccum = [0, 0, 0];

    this.loaded = true;
    this._cycleAccum = 0;
  }

  renderSample() {
    if (!this.loaded) return [0, 0];
    let budget = CPU_CYCLES_PER_SAMPLE + this._cycleAccum;
    let guard = 0;
    while (budget > 0 && guard < 64) {
      budget -= this.cpu.step();
      guard++;
    }
    this._cycleAccum = budget;
    return this.dsp.generateSample();
  }
}


// ============================================================================
// 5. SPCPlayer: ウルトラハイファイ オーディオ プレイヤー クラス
// ============================================================================
const SDSP_SAMPLE_RATE = 32000;

class SPCPlayer {
  constructor(audioCtx) {
    this.audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    this.engine = new SPCEngine();
    this.playing = false;

    this.resampleRatio = SDSP_SAMPLE_RATE / this.audioCtx.sampleRate;
    this.srcPos = 0;
    this.haveSample = false;

    // 高音質DSPリサンプリング用履歴バッファ (4点キュービック用)
    this.histL = [0, 0, 0, 0];
    this.histR = [0, 0, 0, 0];

    // マスタリングエフェクトの構築
    this.exciter = new HighFreqExciter(this.audioCtx.sampleRate);
this.expander = new StereoExpander(this.audioCtx.sampleRate);

    this.onVoiceInfo = null;

    // ScriptProcessorNode の生成 (4096バッファサイズ)
    this.scriptNode = this.audioCtx.createScriptProcessor(4096, 0, 2);
    this.scriptNode.onaudioprocess = (e) => this._process(e);
  }

  load(parsed) {
    this.engine.loadSPC(parsed);
    this.playing = true;
    this.srcPos = 0;
    this.haveSample = false;
    this.histL.fill(0);
    this.histR.fill(0);
  }

  play() {
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    this.scriptNode.connect(this.audioCtx.destination);
    this.playing = true;
  }

  stop() {
    this.playing = false;
    this.scriptNode.disconnect();
  }

  _advanceDspSample() {
    this.histL.shift();
    this.histR.shift();
    const [l, r] = this.engine.renderSample();
    this.histL.push(l);
    this.histR.push(r);
  }

  _getVoiceInfo() {
    const dsp = this.engine.dsp;
    const voices = [];
    for (let i = 0; i < 8; i++) {
      const voice = dsp.voices[i];
      voices.push({
        voice: i + 1,
        volumeL: dsp.volL(i),
        volumeR: dsp.volR(i),
        pitch: dsp.pitch(i),
        envelope: voice.envLevel,
        active: voice.envMode !== "off"
      });
    }
    return voices;
  }

  _process(e) {
    const output = e.outputBuffer;
    const left = output.getChannelData(0);
    const right = output.getChannelData(1);
    const n = left.length;

    if (!this.playing || !this.engine.loaded) {
      left.fill(0); right.fill(0); return;
    }

    if (!this.haveSample) {
      for (let k = 0; k < 4; k++) this._advanceDspSample();
      this.haveSample = true;
    }

    for (let i = 0; i < n; i++) {
      while (this.srcPos >= 1) {
        this._advanceDspSample();
        this.srcPos -= 1;
      }

      const frac = this.srcPos;
     
      // _process 内の 1. リサンプリング部分を以下に差し替え
let sampleL = cubicInterpolate(this.histL[0], this.histL[1], this.histL[2], this.histL[3], frac);
let sampleR = cubicInterpolate(this.histR[0], this.histR[1], this.histR[2], this.histR[3], frac);
      // 2. 超高域エキサイターによる倍音添加 (高域の明瞭度向上)
      [sampleL, sampleR] = this.exciter.process(sampleL, sampleR);

      // 3. ステレオ効果の自然な拡張
      [sampleL, sampleR] = this.expander.process(sampleL, sampleR);

      // 4. 透明感のあるリミッター処理
      left[i] = cleanSoftLimit(sampleL);
      right[i] = cleanSoftLimit(sampleR);

      this.srcPos += this.resampleRatio;
    }

    if (typeof this.onVoiceInfo === 'function') {
      this.onVoiceInfo(this._getVoiceInfo());
    }
  }
}

// ----------------------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------------------
function pitchToNote(pitch) {
  if (!pitch) return "-";
  const freq = 32000 * pitch / 4096;
  if (!isFinite(freq) || freq <= 0) return "-";

  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  const octave = Math.floor(midi / 12) - 1;
  const name = noteNames[((midi % 12) + 12) % 12];

  return `${name}${octave}`;
}