'use strict';
/* =========================================================================
   GLEAM — jewel-cascade puzzle engine
   ========================================================================= */

/* ---------------------------------------------------------------------
   Sound manager — tiny synthesized SFX via WebAudio (no audio assets)
--------------------------------------------------------------------- */
const Sound = {
  ctx: null,
  muted: localStorage.getItem('gleam_muted') === '1',
  ensure(){
    if(!this.ctx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(AC) this.ctx = new AC();
    }
    if(this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, opts={}){
    if(this.muted) return;
    this.ensure();
    if(!this.ctx) return;
    const t0 = this.ctx.currentTime + (opts.delay||0);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if(opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0+dur);
    const peak = opts.gain !== undefined ? opts.gain : 0.14;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0+0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0+dur+0.02);
  },
  rotate(){ this.tone(760, 0.06, {type:'triangle', gain:0.09}); },
  move(){ this.tone(340, 0.03, {type:'square', gain:0.035}); },
  hardDrop(){ this.tone(520, 0.09, {type:'sine', slideTo:160, gain:0.12}); },
  lock(){ this.tone(160, 0.07, {type:'sine', gain:0.10}); },
  clear(chain){
    const base = 480 * Math.pow(1.18, Math.min(chain,6));
    this.tone(base, 0.16, {type:'triangle', slideTo:base*1.6, gain:0.16});
  },
  garbage(){ this.tone(120, 0.22, {type:'sawtooth', slideTo:70, gain:0.10}); },
  levelUp(){
    this.tone(520, 0.12, {type:'triangle', gain:0.13, delay:0});
    this.tone(660, 0.14, {type:'triangle', gain:0.13, delay:0.09});
    this.tone(880, 0.18, {type:'triangle', gain:0.13, delay:0.18});
  },
  gameOver(){
    this.tone(300, 0.18, {type:'sawtooth', gain:0.12, delay:0});
    this.tone(220, 0.22, {type:'sawtooth', gain:0.12, delay:0.15});
    this.tone(140, 0.32, {type:'sawtooth', gain:0.12, delay:0.32});
  },
  toggle(){
    this.muted = !this.muted;
    localStorage.setItem('gleam_muted', this.muted ? '1':'0');
    return this.muted;
  }
};

function vibrate(pattern){
  if(navigator.vibrate){ try{ navigator.vibrate(pattern); }catch(e){} }
}

function faDigits(n){
  const map = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  return String(n).replace(/[0-9]/g, d => map[d]);
}

/* ---------------------------------------------------------------------
   Gem palette & board constants
--------------------------------------------------------------------- */
const GEMS = [
  {id:0, color:'#ff5470', glow:'#ffc2cf'},
  {id:1, color:'#3aa0ff', glow:'#c7e6ff'},
  {id:2, color:'#2be3a1', glow:'#c8ffe9'},
  {id:3, color:'#b26bff', glow:'#e7d1ff'},
  {id:4, color:'#ffc648', glow:'#fff0c2'},
  {id:5, color:'#33e0ff', glow:'#cdf9ff'},
  {id:6, color:'#f4f6ff', glow:'#ffffff'},
];
const STONE = -2;
const COLS = 6;
const ROWS = 13;
const SPAWN_COL = 2;

function shade(hex, percent){
  const num = parseInt(hex.slice(1),16);
  let r = (num>>16)+Math.round(2.55*percent);
  let g = (num>>8 & 0x00FF)+Math.round(2.55*percent);
  let b = (num & 0x0000FF)+Math.round(2.55*percent);
  r=Math.max(0,Math.min(255,r)); g=Math.max(0,Math.min(255,g)); b=Math.max(0,Math.min(255,b));
  return '#'+(0x1000000+r*0x10000+g*0x100+b).toString(16).slice(1);
}

class Particle{
  constructor(x,y,color){
    this.x=x; this.y=y;
    const a = Math.random()*Math.PI*2;
    const s = 1.5+Math.random()*3.5;
    this.vx = Math.cos(a)*s; this.vy = Math.sin(a)*s - 1.5;
    this.life = 1; this.color=color; this.r = 2+Math.random()*2.2;
  }
  update(dt){
    this.x += this.vx*dt*60; this.y += this.vy*dt*60;
    this.vy += 0.12*dt*60;
    this.life -= dt*1.4;
  }
  draw(ctx){
    if(this.life<=0) return;
    ctx.globalAlpha = Math.max(this.life,0);
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x,this.y,this.r,0,Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/* ---------------------------------------------------------------------
   Board — one player's play-field, logic + rendering
--------------------------------------------------------------------- */
class Board{
  constructor(opts){
    this.playerIndex = opts.playerIndex;
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d');
    this.frameEl = opts.frameEl;
    this.difficulty = opts.difficulty || 'normal';
    this.onScoreChange = opts.onScoreChange || function(){};
    this.onNextChange = opts.onNextChange || function(){};
    this.onGameOver = opts.onGameOver || function(){};
    this.onLevelUp = opts.onLevelUp || function(){};
    this.onCombo = opts.onCombo || function(){};
    this.opponent = null;

    this.cell = 34;
    this.reset();
  }

  reset(){
    this.grid = Array.from({length:ROWS}, ()=>Array(COLS).fill(null));
    this.score = 0;
    this.level = 1;
    this.jewels = 0;
    this.chainCount = 0;
    this.gameOver = false;
    this.paused = false;
    this.particles = [];
    this.pendingGarbage = 0;
    this.fallAcc = 0;
    this.lockAcc = 0;
    this.lockDelay = 0.4;
    this.locking = false;
    this.softDrop = false;
    this.heldDir = 0;
    this.dasTimer = 0;
    this.dasStage = 'delay';
    this.shakeTimer = 0;
    this.state = 'falling';
    this.resolveTimer = 0;
    this.resolveStep = null;

    const diffColors = {easy:4, normal:5, hard:6};
    this.baseColors = diffColors[this.difficulty] || 5;

    this.next = this.randomPiece();
    this.spawnPiece();
  }

  numColors(){
    return Math.min(this.baseColors + Math.floor((this.level-1)/3), GEMS.length);
  }

  randomPiece(){
    const n = this.numColors();
    const arr = [];
    for(let i=0;i<3;i++) arr.push(Math.floor(Math.random()*n));
    return arr;
  }

  spawnPiece(){
    this.piece = {col: SPAWN_COL, row: -3, colors: this.next};
    this.next = this.randomPiece();
    this.onNextChange(this.next);
    this.lockAcc = 0;
    this.locking = false;
    if(this.grid[0][SPAWN_COL] !== null){
      this.triggerGameOver();
    }
  }

  triggerGameOver(){
    this.state = 'over';
    this.gameOver = true;
    Sound.gameOver();
    vibrate([80,40,80,40,120]);
    this.onGameOver();
  }

  cellBlocked(row,col){
    if(col<0 || col>=COLS) return true;
    if(row>=ROWS) return true;
    if(row<0) return false;
    return this.grid[row][col] !== null;
  }

  canPlace(row,col){
    for(let i=0;i<3;i++){
      if(this.cellBlocked(row+i, col)) return false;
    }
    return true;
  }

  move(dir){
    if(this.state!=='falling' || !this.piece) return;
    const nc = this.piece.col + dir;
    if(this.canPlace(this.piece.row, nc)){
      this.piece.col = nc;
      this.lockAcc = 0;
      Sound.move();
    }
  }

  setHeldDir(dir){
    this.heldDir = dir;
    this.dasTimer = 0;
    this.dasStage = 'delay';
    this.move(dir);
  }

  clearHeldDir(dir){
    if(this.heldDir === dir) this.heldDir = 0;
  }

  rotate(){
    if(this.state!=='falling' || !this.piece) return;
    const c = this.piece.colors;
    this.piece.colors = [c[2], c[0], c[1]];
    Sound.rotate();
  }

  fallInterval(){
    const lvl = this.level;
    const base = 780 - (lvl-1)*38;
    const min = 110;
    let interval = Math.max(base, min);
    if(this.softDrop) interval = interval/9;
    return interval/1000;
  }

  update(dt){
    if(this.state==='over') return;
    if(this.paused) return;

    this.particles.forEach(p=>p.update(dt));
    this.particles = this.particles.filter(p=>p.life>0);
    if(this.shakeTimer>0){
      this.shakeTimer -= dt;
      if(this.shakeTimer<=0) this.frameEl.classList.remove('shake');
    }

    if(this.state==='falling') this.updateFalling(dt);
    else if(this.state==='resolving') this.updateResolving(dt);
  }

  updateFalling(dt){
    if(!this.piece) return;

    if(this.heldDir !== 0){
      this.dasTimer += dt;
      if(this.dasStage === 'delay'){
        if(this.dasTimer >= 0.17){
          this.dasStage = 'repeat';
          this.dasTimer = 0;
          this.move(this.heldDir);
        }
      } else if(this.dasTimer >= 0.045){
        this.dasTimer -= 0.045;
        this.move(this.heldDir);
      }
    }

    const canFall = this.canPlace(this.piece.row+1, this.piece.col);
    if(canFall){
      this.fallAcc += dt;
      const interval = this.fallInterval();
      while(this.fallAcc >= interval){
        this.fallAcc -= interval;
        this.piece.row += 1;
      }
      this.locking = false;
      this.lockAcc = 0;
    } else {
      this.locking = true;
      this.lockAcc += dt;
      if(this.lockAcc >= this.lockDelay) this.lockPiece();
    }
  }

  hardDrop(){
    if(this.state!=='falling' || !this.piece) return;
    let dist=0;
    while(this.canPlace(this.piece.row+1, this.piece.col)){
      this.piece.row += 1; dist++;
    }
    this.score += dist*2;
    this.onScoreChange();
    Sound.hardDrop();
    this.lockPiece();
  }

  lockPiece(){
    const {row,col,colors} = this.piece;
    for(let i=0;i<3;i++){
      const r = row+i;
      if(r>=0 && r<ROWS) this.grid[r][col] = colors[i];
    }
    this.piece = null;
    this.chainCount = 0;
    this.state = 'resolving';
    this.resolveStep = 'match';
    this.resolveTimer = 0.05;
    Sound.lock();
    vibrate(8);
  }

  updateResolving(dt){
    this.resolveTimer -= dt;
    if(this.resolveTimer>0) return;

    if(this.resolveStep === 'match'){
      const matches = this.findMatches();
      if(matches.size===0){
        this.deliverGarbageIfAny();
        this.state = 'falling';
        this.spawnPiece();
        return;
      }
      this.chainCount++;
      this.clearMatched(matches);
      this.resolveStep = 'settle';
      this.resolveTimer = 0.22;
    } else if(this.resolveStep === 'settle'){
      this.applyGravity();
      this.resolveStep = 'match';
      this.resolveTimer = 0.16;
    }
  }

  findMatches(){
    const g = this.grid;
    const marked = new Set();
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    for(let r=0;r<ROWS;r++){
      for(let c=0;c<COLS;c++){
        const val = g[r][c];
        if(val===null || val===STONE) continue;
        for(const [dr,dc] of dirs){
          let run=[[r,c]];
          let rr=r+dr, cc=c+dc;
          while(rr>=0&&rr<ROWS&&cc>=0&&cc<COLS&&g[rr][cc]===val){
            run.push([rr,cc]);
            rr+=dr; cc+=dc;
          }
          if(run.length>=3) run.forEach(([a,b])=>marked.add(a+','+b));
        }
      }
    }
    return marked;
  }

  clearMatched(marked){
    const g = this.grid;
    const cellsToClear = new Set(marked);
    marked.forEach(key=>{
      const [r,c] = key.split(',').map(Number);
      [[r-1,c],[r+1,c],[r,c-1],[r,c+1]].forEach(([rr,cc])=>{
        if(rr>=0&&rr<ROWS&&cc>=0&&cc<COLS&&g[rr][cc]===STONE) cellsToClear.add(rr+','+cc);
      });
    });

    let count=0;
    cellsToClear.forEach(key=>{
      const [r,c] = key.split(',').map(Number);
      const val = g[r][c];
      if(val!==null){
        this.spawnClearParticles(r,c,val);
        g[r][c] = null;
        if(val!==STONE) count++;
      }
    });

    this.jewels += count;
    const mult = this.chainCount;
    const gained = count*10*mult;
    this.score += gained;
    Sound.clear(this.chainCount);
    vibrate(this.chainCount>=2 ? [25,15,25] : 12);

    const newLevel = 1 + Math.floor(this.jewels/24);
    if(newLevel !== this.level){
      this.level = newLevel;
      Sound.levelUp();
      this.onLevelUp();
    }
    this.onScoreChange();

    if(this.chainCount>=2){
      this.onCombo(this.chainCount, gained);
      this.shakeTimer = 0.35;
      this.frameEl.classList.add('shake');
    }

    if(this.chainCount>=2 && this.opponent && !this.opponent.gameOver){
      const garbage = Math.min(6, Math.floor(this.chainCount*1.5)+Math.floor(count/6));
      this.opponent.pendingGarbage += garbage;
      Sound.garbage();
    }
  }

  spawnClearParticles(r,c,val){
    const px = c*this.cell + this.cell/2;
    const py = r*this.cell + this.cell/2;
    const color = val===STONE ? '#b7bdc6' : GEMS[val].glow;
    for(let i=0;i<7;i++) this.particles.push(new Particle(px,py,color));
  }

  applyGravity(){
    const g = this.grid;
    for(let c=0;c<COLS;c++){
      let write = ROWS-1;
      for(let r=ROWS-1;r>=0;r--){
        if(g[r][c]!==null){
          g[write][c] = g[r][c];
          if(write!==r) g[r][c]=null;
          write--;
        }
      }
      for(let r=write;r>=0;r--) g[r][c]=null;
    }
  }

  deliverGarbageIfAny(){
    if(this.pendingGarbage<=0) return;
    let n = this.pendingGarbage;
    this.pendingGarbage = 0;
    const cols = [...Array(COLS).keys()];
    for(let i=cols.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [cols[i],cols[j]] = [cols[j],cols[i]];
    }
    let placed=0;
    for(const c of cols){
      if(placed>=n) break;
      let r=-1;
      for(let rr=ROWS-1; rr>=0; rr--){ if(this.grid[rr][c]===null){ r=rr; break; } }
      if(r===-1) continue;
      this.grid[r][c] = STONE;
      placed++;
    }
  }

  ghostRow(){
    if(!this.piece) return null;
    let r = this.piece.row;
    while(this.canPlace(r+1, this.piece.col)) r++;
    return r;
  }

  render(){
    const ctx = this.ctx;
    const cell = this.cell;
    const w = COLS*cell, h = ROWS*cell;
    ctx.clearRect(0,0,w,h);

    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for(let c=0;c<=COLS;c++){ ctx.beginPath(); ctx.moveTo(c*cell,0); ctx.lineTo(c*cell,h); ctx.stroke(); }
    for(let r=0;r<=ROWS;r++){ ctx.beginPath(); ctx.moveTo(0,r*cell); ctx.lineTo(w,r*cell); ctx.stroke(); }

    for(let r=0;r<ROWS;r++){
      for(let c=0;c<COLS;c++){
        const v = this.grid[r][c];
        if(v!==null) this.drawGem(ctx, c*cell+cell/2, r*cell+cell/2, cell*0.40, v);
      }
    }

    if(this.piece && this.state==='falling'){
      const gr = this.ghostRow();
      if(gr!==null){
        ctx.globalAlpha = 0.18;
        for(let i=0;i<3;i++){
          const rr = gr+i;
          if(rr>=0) this.drawGem(ctx, this.piece.col*cell+cell/2, rr*cell+cell/2, cell*0.38, this.piece.colors[i], true);
        }
        ctx.globalAlpha = 1;
      }
    }

    if(this.piece){
      for(let i=0;i<3;i++){
        const rr = this.piece.row+i;
        if(rr>=0 && rr<ROWS) this.drawGem(ctx, this.piece.col*cell+cell/2, rr*cell+cell/2, cell*0.40, this.piece.colors[i]);
      }
    }

    this.particles.forEach(p=>p.draw(ctx));

    if(this.paused && this.state!=='over'){
      ctx.fillStyle = 'rgba(6,7,12,0.55)';
      ctx.fillRect(0,0,w,h);
    }
  }

  drawGem(ctx, x, y, r, val, flat){
    ctx.save();
    if(val===STONE){
      const grad = ctx.createRadialGradient(x-r*0.3,y-r*0.3,r*0.1,x,y,r);
      grad.addColorStop(0,'#c7cbd4');
      grad.addColorStop(1,'#666b76');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
      ctx.restore();
      return;
    }
    const gem = GEMS[val];
    if(!flat){ ctx.shadowColor = gem.color; ctx.shadowBlur = r*0.85; }
    const grad = ctx.createRadialGradient(x-r*0.3,y-r*0.35,r*0.12,x,y,r);
    grad.addColorStop(0, gem.glow);
    grad.addColorStop(0.6, gem.color);
    grad.addColorStop(1, shade(gem.color,-25));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.ellipse(x-r*0.32, y-r*0.32, r*0.2, r*0.11, -0.5, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
}

/* =========================================================================
   Game controller — screens, layout, input, HUD wiring
   ========================================================================= */
const menuScreen = document.getElementById('menu');
const gameScreen = document.getElementById('game');
const gameStage = document.getElementById('game-stage');
const boardsWrap = document.getElementById('boards-wrap');
const btnPause = document.getElementById('btn-pause');
const btnMenu = document.getElementById('btn-menu');
const btnSound = document.getElementById('btn-sound');
const btnSoundGame = document.getElementById('btn-sound-game');
const btnFullscreen = document.getElementById('btn-fullscreen');

const pauseModal = document.getElementById('pause-modal');
const btnResume = document.getElementById('btn-resume');
const btnRestartPause = document.getElementById('btn-restart-pause');
const btnMenuPause = document.getElementById('btn-menu-pause');

const landscapeHint = document.getElementById('landscape-hint');
const btnDismissHint = document.getElementById('btn-dismiss-hint');

const bestScoreVal = document.getElementById('best-score-val');

const ICON_MUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
const ICON_SOUND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>';
const ICON_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
const ICON_COMPRESS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v3a2 2 0 0 1-2 2H4M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';

function refreshSoundIcons(){
  const html = Sound.muted ? ICON_MUTE : ICON_SOUND;
  if(btnSound) btnSound.innerHTML = html;
  if(btnSoundGame) btnSoundGame.innerHTML = html;
}
refreshSoundIcons();
if(btnSound) btnSound.addEventListener('click', ()=>{ Sound.toggle(); refreshSoundIcons(); });
if(btnSoundGame) btnSoundGame.addEventListener('click', ()=>{ Sound.toggle(); refreshSoundIcons(); });

/* ---------------------------------------------------------------------
   Best score persistence
--------------------------------------------------------------------- */
const BEST_KEY = 'gleam_best_score';
function getBest(){ return parseInt(localStorage.getItem(BEST_KEY)||'0', 10); }
function setBestIfHigher(score){
  const best = getBest();
  if(score > best){ localStorage.setItem(BEST_KEY, String(score)); return true; }
  return false;
}
function refreshBestScoreDisplay(){
  if(bestScoreVal) bestScoreVal.textContent = faDigits(getBest());
}
refreshBestScoreDisplay();

/* ---------------------------------------------------------------------
   Difficulty selection
--------------------------------------------------------------------- */
let difficulty = 'normal';
document.querySelectorAll('.diff-chip').forEach(chip=>{
  chip.addEventListener('click', ()=>{
    document.querySelectorAll('.diff-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    difficulty = chip.dataset.diff;
  });
});

let boards = [];
let mode = 1;
let rafId = null;
let lastTime = null;
let paused = false;
let playerUnitsRefs = [];
let hintDismissed = false;

function showScreen(el){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  el.classList.add('active');
}

/* ---------------------------------------------------------------------
   Responsive board sizing — measured from actual rendered DOM,
   so the play-field always fills available space edge-to-edge.
--------------------------------------------------------------------- */
function layoutBoards(){
  if(playerUnitsRefs.length===0) return null;
  const n = playerUnitsRefs.length;
  const wrapRect = boardsWrap.getBoundingClientRect();
  if(wrapRect.width<=0 || wrapRect.height<=0) return null;

  const sample = playerUnitsRefs[0];
  const statH = sample.statBar.offsetHeight;
  const controlsH = sample.controlsWrap.offsetHeight; // 0 when hidden (desktop)
  const unitStyle = getComputedStyle(sample.unit);
  const unitGap = parseFloat(unitStyle.rowGap || unitStyle.gap) || 8;
  const gapsCount = controlsH>0 ? 2 : 1;
  const framePad = 9*2;
  const wrapGap = 20;

  const availW = wrapRect.width - wrapGap*(n-1);
  const perW = availW/n;
  const availH = wrapRect.height - statH - controlsH - unitGap*gapsCount;

  const cellW = (perW - framePad)/COLS;
  const cellH = (availH - framePad)/ROWS;
  let cellSize = Math.floor(Math.min(cellW, cellH));
  cellSize = Math.max(15, Math.min(cellSize, 46));

  playerUnitsRefs.forEach((u,i)=>{
    u.canvas.width = COLS*cellSize;
    u.canvas.height = ROWS*cellSize;
    if(boards[i]) boards[i].cell = cellSize;
  });
  return cellSize;
}

function checkOrientationHint(){
  if(!gameScreen.classList.contains('active')){
    landscapeHint.classList.remove('show');
    return;
  }
  const isPhoneLandscape = window.innerHeight < 480 && window.innerWidth > window.innerHeight;
  if(isPhoneLandscape && !hintDismissed) landscapeHint.classList.add('show');
  else landscapeHint.classList.remove('show');
}
btnDismissHint.addEventListener('click', ()=>{ hintDismissed = true; landscapeHint.classList.remove('show'); });

function handleViewportChange(){
  if(!gameScreen.classList.contains('active')) return;
  layoutBoards();
  checkOrientationHint();
}
window.addEventListener('resize', handleViewportChange);
window.addEventListener('orientationchange', ()=>{ hintDismissed = false; setTimeout(handleViewportChange, 250); });
if(window.visualViewport){
  window.visualViewport.addEventListener('resize', handleViewportChange);
}

/* ---------------------------------------------------------------------
   Building per-player DOM (stat bar, board, touch controls)
--------------------------------------------------------------------- */
function buildBoardsUI(numPlayers){
  boardsWrap.innerHTML = '';
  playerUnitsRefs = [];
  const units = [];

  for(let p=0;p<numPlayers;p++){
    const unit = document.createElement('div');
    unit.className = 'player-unit';

    const statBar = document.createElement('div');
    statBar.className = 'stat-bar' + (p===1 ? ' p2' : '');
    statBar.innerHTML = `
      <span class="p-tag">${numPlayers===1 ? 'بازیکن' : (p===0?'بازیکن ۱':'بازیکن ۲')}</span>
      <div class="stat"><span class="n score-val">0</span><span class="l">امتیاز</span></div>
      <div class="stat"><span class="n level-val">1</span><span class="l">مرحله</span></div>
      <div class="stat"><span class="n jewel-val">0</span><span class="l">جواهر</span></div>
      <div class="next-dots"></div>
    `;
    unit.appendChild(statBar);

    const frame = document.createElement('div');
    frame.className = 'board-frame';
    const canvas = document.createElement('canvas');
    canvas.className = 'board-canvas';
    canvas.width = COLS*28;
    canvas.height = ROWS*28;
    frame.appendChild(canvas);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = '<h2 class="ov-title"></h2><p class="ov-sub"></p><button class="pill-btn primary ov-restart" style="margin-top:8px;">دوباره بازی کن</button>';
    frame.appendChild(overlay);

    unit.appendChild(frame);

    const controlsWrap = document.createElement('div');
    controlsWrap.className = 'board-controls';
    const group = document.createElement('div');
    group.className='mc-group';
    const mk=(label,row,col)=>{const b=document.createElement('div'); b.className='mc-btn'; b.style.gridRow=row; b.style.gridColumn=col; b.textContent=label; return b;};
    const rotateBtn = mk('⟳',1,2);
    const leftBtn = mk('←',2,1);
    const dropBtn = mk('↓',2,2);
    const rightBtn = mk('→',2,3);
    const hardBtn = mk('⤓',1,1);
    group.appendChild(rotateBtn); group.appendChild(leftBtn); group.appendChild(dropBtn); group.appendChild(rightBtn); group.appendChild(hardBtn);
    controlsWrap.appendChild(group);
    unit.appendChild(controlsWrap);

    boardsWrap.appendChild(unit);

    const ref = {unit, frame, canvas, overlay, statBar, controlsWrap};
    units.push(ref);
    playerUnitsRefs.push(ref);

    const bind = (el, downFn, upFn)=>{
      el.addEventListener('touchstart', e=>{e.preventDefault(); Sound.ensure(); downFn();});
      if(upFn){
        el.addEventListener('touchend', e=>{e.preventDefault(); upFn();});
        el.addEventListener('touchcancel', e=>{e.preventDefault(); upFn();});
      }
    };
    bind(leftBtn, ()=>controllerAction(p,'leftDown'), ()=>controllerAction(p,'leftUp'));
    bind(rightBtn, ()=>controllerAction(p,'rightDown'), ()=>controllerAction(p,'rightUp'));
    bind(rotateBtn, ()=>controllerAction(p,'rotate'));
    bind(hardBtn, ()=>controllerAction(p,'hard'));
    bind(dropBtn, ()=>controllerAction(p,'softOn'), ()=>controllerAction(p,'softOff'));
  }

  return units;
}

function renderNextPreview(container, colors){
  container.innerHTML = '';
  colors.forEach(idx=>{
    const dot = document.createElement('div');
    dot.className='dot';
    dot.style.background = `radial-gradient(circle at 35% 30%, ${GEMS[idx].glow}, ${GEMS[idx].color} 60%, ${shade(GEMS[idx].color,-25)})`;
    dot.style.boxShadow = `0 0 6px ${GEMS[idx].color}`;
    container.appendChild(dot);
  });
}

function bump(el, text){
  el.textContent = text;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function spawnComboToast(frameEl, chain, points){
  const el = document.createElement('div');
  el.className = 'combo-toast';
  el.innerHTML = `×${chain} COMBO<span class="pts">+${points}</span>`;
  frameEl.appendChild(el);
  setTimeout(()=>el.remove(), 950);
}

/* ---------------------------------------------------------------------
   Game lifecycle
--------------------------------------------------------------------- */
function startGame(numPlayers){
  Sound.ensure();
  mode = numPlayers;
  document.body.classList.add('playing');
  showScreen(gameScreen);

  const units = buildBoardsUI(numPlayers);
  const cellSize = layoutBoards() || 28;
  boards = [];

  units.forEach((u,i)=>{
    const board = new Board({
      playerIndex:i,
      canvas:u.canvas,
      frameEl:u.frame,
      difficulty,
      onScoreChange:()=>{
        bump(u.statBar.querySelector('.score-val'), board.score);
        bump(u.statBar.querySelector('.level-val'), board.level);
        bump(u.statBar.querySelector('.jewel-val'), board.jewels);
      },
      onNextChange:(next)=>{ renderNextPreview(u.statBar.querySelector('.next-dots'), next); },
      onGameOver:()=>{ handleGameOver(i); },
      onLevelUp:()=>{},
      onCombo:(chain, pts)=>{ spawnComboToast(u.frame, chain, pts); }
    });
    board.cell = cellSize;
    boards.push(board);
  });

  if(numPlayers===2){
    boards[0].opponent = boards[1];
    boards[1].opponent = boards[0];
  }

  boards.forEach(b=>{ b.onScoreChange(); b.onNextChange(b.next); });

  setPaused(false);
  lastTime = null;
  if(rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);

  checkOrientationHint();
}

function goToMenu(){
  if(rafId) cancelAnimationFrame(rafId);
  document.body.classList.remove('playing');
  pauseModal.classList.remove('show');
  landscapeHint.classList.remove('show');
  if(document.fullscreenElement){
    (document.exitFullscreen && document.exitFullscreen()) ||
    (document.webkitExitFullscreen && document.webkitExitFullscreen());
  }
  refreshBestScoreDisplay();
  showScreen(menuScreen);
}

function handleGameOver(i){
  const units = document.querySelectorAll('.player-unit');
  const overlay = units[i].querySelector('.overlay');
  const title = overlay.querySelector('.ov-title');
  const sub = overlay.querySelector('.ov-sub');

  if(mode===1){
    const improved = setBestIfHigher(boards[i].score);
    title.textContent = 'بازی تمام شد';
    sub.textContent = improved ? `رکورد جدید! امتیاز: ${boards[i].score}` : `امتیاز نهایی: ${boards[i].score}`;
    overlay.classList.add('show');
  } else {
    const other = boards[1-i];
    if(!other.gameOver){
      title.textContent = 'باختی!';
      sub.textContent = `بازیکن ${2-i} برنده شد`;
      overlay.classList.add('show');
    } else {
      setBestIfHigher(boards[0].score);
      setBestIfHigher(boards[1].score);
      const winnerIdx = boards[0].score===boards[1].score ? -1 : (boards[0].score>boards[1].score?0:1);
      boards.forEach((b,idx)=>{
        const ov = units[idx].querySelector('.overlay');
        const t = ov.querySelector('.ov-title');
        const s = ov.querySelector('.ov-sub');
        if(winnerIdx===-1) t.textContent='مساوی!';
        else t.textContent = (winnerIdx===idx) ? 'برنده شدی!' : 'باختی!';
        s.textContent = `امتیاز: ${b.score}`;
        ov.classList.add('show');
      });
    }
  }

  const restartBtn = overlay.querySelector('.ov-restart');
  restartBtn.onclick = ()=> startGame(mode);
}

/* ---------------------------------------------------------------------
   Input
--------------------------------------------------------------------- */
function controllerAction(playerIdx, action){
  const b = boards[playerIdx];
  if(!b || paused) return;
  switch(action){
    case 'leftDown': b.setHeldDir(-1); break;
    case 'rightDown': b.setHeldDir(1); break;
    case 'leftUp': b.clearHeldDir(-1); break;
    case 'rightUp': b.clearHeldDir(1); break;
    case 'rotate': b.rotate(); break;
    case 'hard': b.hardDrop(); break;
    case 'softOn': b.softDrop = true; break;
    case 'softOff': b.softDrop = false; break;
  }
}

function handleKey(e, isDown){
  if(!gameScreen.classList.contains('active')) return;
  const key = e.key;
  const lower = key.length===1 ? key.toLowerCase() : key;
  let used = false;

  if(isDown) Sound.ensure();

  if(isDown && key==='Escape'){ setPaused(!paused); used=true; }

  if(isDown){
    if(key==='ArrowLeft'){ if(!e.repeat) controllerAction(0,'leftDown'); used=true; }
    else if(key==='ArrowRight'){ if(!e.repeat) controllerAction(0,'rightDown'); used=true; }
    else if(key==='ArrowUp'){ if(!e.repeat) controllerAction(0,'rotate'); used=true; }
    else if(key==='ArrowDown'){ controllerAction(0,'softOn'); used=true; }
    else if(key===' '){ if(!e.repeat) controllerAction(0,'hard'); used=true; }
  } else {
    if(key==='ArrowLeft'){ controllerAction(0,'leftUp'); used=true; }
    else if(key==='ArrowRight'){ controllerAction(0,'rightUp'); used=true; }
    else if(key==='ArrowDown'){ controllerAction(0,'softOff'); used=true; }
  }

  if(mode===2){
    if(isDown){
      if(lower==='a'){ if(!e.repeat) controllerAction(1,'leftDown'); used=true; }
      else if(lower==='d'){ if(!e.repeat) controllerAction(1,'rightDown'); used=true; }
      else if(lower==='w'){ if(!e.repeat) controllerAction(1,'rotate'); used=true; }
      else if(lower==='s'){ controllerAction(1,'softOn'); used=true; }
      else if(key==='Shift'){ if(!e.repeat) controllerAction(1,'hard'); used=true; }
    } else {
      if(lower==='a'){ controllerAction(1,'leftUp'); used=true; }
      else if(lower==='d'){ controllerAction(1,'rightUp'); used=true; }
      else if(lower==='s'){ controllerAction(1,'softOff'); used=true; }
    }
  }

  if(used) e.preventDefault();
}
window.addEventListener('keydown', e=>handleKey(e,true));
window.addEventListener('keyup', e=>handleKey(e,false));

/* ---------------------------------------------------------------------
   Pause modal
--------------------------------------------------------------------- */
function setPaused(val){
  paused = val;
  boards.forEach(b=>b.paused=paused);
  pauseModal.classList.toggle('show', paused);
}
btnPause.addEventListener('click', ()=> setPaused(!paused));
btnResume.addEventListener('click', ()=> setPaused(false));
btnRestartPause.addEventListener('click', ()=>{ setPaused(false); startGame(mode); });
btnMenuPause.addEventListener('click', goToMenu);
btnMenu.addEventListener('click', goToMenu);

document.getElementById('btn-1p').addEventListener('click', ()=>startGame(1));
document.getElementById('btn-2p').addEventListener('click', ()=>startGame(2));

/* ---------------------------------------------------------------------
   Fullscreen
--------------------------------------------------------------------- */
function updateFullscreenIcon(){
  if(!btnFullscreen) return;
  btnFullscreen.innerHTML = document.fullscreenElement ? ICON_COMPRESS : ICON_EXPAND;
}
if(btnFullscreen){
  btnFullscreen.addEventListener('click', ()=>{
    if(!document.fullscreenElement){
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if(req) req.call(el).catch(()=>{});
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if(exit) exit.call(document).catch?.(()=>{});
    }
  });
}
document.addEventListener('fullscreenchange', updateFullscreenIcon);
document.addEventListener('webkitfullscreenchange', updateFullscreenIcon);

/* ---------------------------------------------------------------------
   Main loop
--------------------------------------------------------------------- */
function loop(ts){
  rafId = requestAnimationFrame(loop);
  if(lastTime===null) lastTime = ts;
  let dt = (ts-lastTime)/1000;
  lastTime = ts;
  dt = Math.min(dt, 0.05);

  boards.forEach(b=>{
    if(!paused) b.update(dt);
    b.render();
  });
}

/* ---------------------------------------------------------------------
   PWA — install prompt + service worker registration
--------------------------------------------------------------------- */
let deferredInstallPrompt = null;
const installBanner = document.getElementById('install-banner');
const btnInstall = document.getElementById('btn-install');

window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  if(installBanner) installBanner.classList.add('show');
});

if(btnInstall){
  btnInstall.addEventListener('click', async ()=>{
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBanner.classList.remove('show');
  });
}

window.addEventListener('appinstalled', ()=>{
  if(installBanner) installBanner.classList.remove('show');
});

if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{ /* offline support unavailable */ });
  });
}
