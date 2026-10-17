/**
 * The WebGL2 context every WebGLRenderer on the page draws with.
 *
 * One context serves any number of terminals: browsers cap live contexts
 * (16 in Chrome, which then drops the oldest), and one context shares
 * compiled programs and glyph atlases. It draws on a canvas outside the
 * document; each renderer draws a frame there and copies the rows that
 * changed onto its own (2D) canvas, which therefore always holds the last
 * frame and can be drawn on with Canvas2D whenever the GPU can't.
 */

/** Notified when the context is lost and when it comes back (resources must then be recreated). */
export interface GLDeviceListener {
  contextLost(): void;
  contextRestored(): void;
}

/** Something on the GPU shared by several renderers (a glyph atlas). */
export interface SharedGLResource {
  /** The context came back: recreate what lived in it. */
  contextRestored(): void;
  dispose(): void;
}

/** A linked program and its uniform locations. */
export interface GLProgram {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export interface GLPrograms {
  /** Cell backgrounds: one texel per cell, looked up per pixel */
  background: GLProgram;
  /** Glyph quads from the atlas, tinted unless they are color glyphs */
  glyph: GLProgram;
  /** Solid rectangles (decorations, cursor, scrollbar), premultiplied colors */
  rect: GLProgram;
}

/**
 * Attribute location of the quad corner, (0,0) to (1,1) over a 4-vertex
 * strip: instanced quads get it from a per-vertex buffer (some drivers want
 * one attribute that isn't per instance).
 */
export const CORNER_LOCATION = 5;

// Device pixels (top-left origin) to clip space
const TO_CLIP = `vec4 toClip(vec2 px) {
  vec2 p = px / u_resolution;
  return vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}`;

const BACKGROUND_VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const BACKGROUND_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D u_cells;
// Viewport left and bottom in window coordinates, and the frame height
uniform vec3 u_frame;
uniform vec2 u_cellSize;
out vec4 outColor;
void main() {
  vec2 px = vec2(gl_FragCoord.x - u_frame.x, u_frame.z - (gl_FragCoord.y - u_frame.y));
  outColor = texelFetch(u_cells, ivec2(px / u_cellSize), 0);
}`;

const GLYPH_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_size;
layout(location = 2) in vec2 a_atlas;
layout(location = 3) in vec4 a_color;
layout(location = 4) in float a_colored;
layout(location = 5) in vec2 a_corner;
uniform vec2 u_resolution;
out vec2 v_atlas;
out vec4 v_color;
flat out int v_colored;
${TO_CLIP}
void main() {
  vec2 offset = a_corner * a_size;
  v_atlas = a_atlas + offset;
  v_color = a_color;
  v_colored = int(a_colored);
  gl_Position = toClip(a_position + offset);
}`;

const GLYPH_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D u_atlas;
in vec2 v_atlas;
in vec4 v_color;
flat in int v_colored;
out vec4 outColor;
void main() {
  vec4 texel = texelFetch(u_atlas, ivec2(v_atlas), 0);
  outColor = v_colored == 1
    ? vec4(texel.rgb * texel.a, texel.a) * v_color.a
    : vec4(v_color.rgb, 1.0) * (v_color.a * texel.a);
}`;

const RECT_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_size;
layout(location = 2) in vec4 a_color;
layout(location = 5) in vec2 a_corner;
uniform vec2 u_resolution;
out vec4 v_color;
${TO_CLIP}
void main() {
  v_color = a_color;
  gl_Position = toClip(a_position + a_corner * a_size);
}`;

const RECT_FRAGMENT = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}`;

export class GLDevice {
  private static current: GLDevice | null = null;

  /**
   * The page's device, created on first use; null when WebGL2 is unavailable
   * or only software-rendered (Canvas2D is faster then). Pair with release().
   */
  static acquire(listener: GLDeviceListener): GLDevice | null {
    if (!GLDevice.current) {
      GLDevice.current = GLDevice.create();
      if (!GLDevice.current) return null;
    }
    GLDevice.current.listeners.add(listener);
    return GLDevice.current;
  }

  private static create(): GLDevice | null {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: true,
      });
    } catch {
      return null;
    }
    if (!gl) return null;
    const programs = createPrograms(gl);
    if (!programs) return null;
    return new GLDevice(canvas, gl, programs);
  }

  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /** Recompiled when the context comes back */
  programs: GLPrograms;
  /** Lost and not back yet: draw with Canvas2D meanwhile */
  lost = false;
  private readonly listeners = new Set<GLDeviceListener>();
  /** Shared resources (atlases) by key, with their user counts */
  private readonly shared = new Map<string, { resource: SharedGLResource; users: number }>();

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, programs: GLPrograms) {
    this.canvas = canvas;
    this.gl = gl;
    this.programs = programs;
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  /** Whether frames can be drawn now. */
  get usable(): boolean {
    return !this.lost && !this.gl.isContextLost();
  }

  /**
   * Grows the shared canvas to hold a `width` x `height` frame (pixels);
   * false when the browser won't make a drawing buffer that big.
   */
  fit(width: number, height: number): boolean {
    const canvas = this.canvas;
    const oldWidth = canvas.width;
    const oldHeight = canvas.height;
    if (width > oldWidth) canvas.width = width;
    if (height > oldHeight) canvas.height = height;
    if (this.gl.drawingBufferWidth >= width && this.gl.drawingBufferHeight >= height) return true;
    // Too big: leave the canvas as the other users fit it
    if (canvas.width !== oldWidth) canvas.width = oldWidth;
    if (canvas.height !== oldHeight) canvas.height = oldHeight;
    return false;
  }

  /**
   * The resource shared by every user asking with the same key (the glyph
   * atlas of one font), created on first use. Pair with releaseShared().
   */
  acquireShared<T extends SharedGLResource>(key: string, create: () => T): T {
    let entry = this.shared.get(key);
    if (!entry) {
      entry = { resource: create(), users: 0 };
      this.shared.set(key, entry);
    }
    entry.users++;
    return entry.resource as T;
  }

  /** Drops a use of a shared resource; the last one disposes it. */
  releaseShared(key: string): void {
    const entry = this.shared.get(key);
    if (!entry) return;
    entry.users--;
    if (entry.users > 0) return;
    this.shared.delete(key);
    entry.resource.dispose();
  }

  release(listener: GLDeviceListener): void {
    this.listeners.delete(listener);
    if (this.listeners.size > 0 || GLDevice.current !== this) return;
    // Last user gone: free the GPU memory now rather than at garbage collection
    GLDevice.current = null;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private handleContextLost = (event: Event): void => {
    // Asks the browser to restore the context when it can
    event.preventDefault();
    this.lost = true;
    for (const listener of this.listeners) listener.contextLost();
  };

  private handleContextRestored = (): void => {
    const programs = createPrograms(this.gl);
    if (!programs) return;
    this.programs = programs;
    this.lost = false;
    for (const { resource } of this.shared.values()) resource.contextRestored();
    for (const listener of this.listeners) listener.contextRestored();
  };
}

function createPrograms(gl: WebGL2RenderingContext): GLPrograms | null {
  const background = createProgram(gl, BACKGROUND_VERTEX, BACKGROUND_FRAGMENT, [
    'u_cells',
    'u_frame',
    'u_cellSize',
  ]);
  const glyph = createProgram(gl, GLYPH_VERTEX, GLYPH_FRAGMENT, ['u_resolution', 'u_atlas']);
  const rect = createProgram(gl, RECT_VERTEX, RECT_FRAGMENT, ['u_resolution']);
  if (!background || !glyph || !rect) return null;
  return { background, glyph, rect };
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  uniformNames: string[]
): GLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    console.warn('ghostty-web: WebGL program failed to link:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  const uniforms: GLProgram['uniforms'] = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    console.warn('ghostty-web: WebGL shader failed to compile:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
