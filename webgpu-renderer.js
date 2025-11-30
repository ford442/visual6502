/**
 * WebGPU Renderer for Visual6502 - "Cyber-Silicon" Aesthetic
 * 
 * This renderer provides a WebGPU-based visualization for the MOS 6502 chip
 * simulator, featuring texture-based rendering with dynamic signal states.
 * 
 * Copyright (c) 2024 Visual6502 Contributors
 * License: MIT
 */

/**
 * @typedef {Object} WebGPURendererOptions
 * @property {HTMLCanvasElement} canvas - The canvas element to render to
 * @property {Array} segdefs - Segment definitions from the simulator
 * @property {string} [substrateTextureUrl] - URL for the substrate texture
 * @property {string} [activeTextureUrl] - URL for the active/glow texture
 */

class WebGPURenderer {
    /**
     * Create a new WebGPURenderer instance
     * @param {WebGPURendererOptions} options
     */
    constructor(options) {
        this.canvas = options.canvas;
        this.segdefs = options.segdefs || [];
        this.substrateTextureUrl = options.substrateTextureUrl;
        this.activeTextureUrl = options.activeTextureUrl;
        
        // WebGPU resources
        this.device = null;
        this.context = null;
        this.pipeline = null;
        this.vertexBuffer = null;
        this.uniformBuffer = null;
        this.nodeStateBuffer = null;
        this.bindGroup = null;
        
        // Geometry data
        this.vertices = null;
        this.vertexCount = 0;
        this.nodeCount = 0;
        
        // Uniforms
        this.time = 0;
        this.zoomLevel = 1.0;
        this.pan = [0, 0];
        
        // Textures
        this.substrateTexture = null;
        this.activeTexture = null;
        this.sampler = null;
        
        // Animation state
        this.animationFrameId = null;
        this.isRunning = false;
        
        // Chip coordinate constants (from expertWires.js)
        this.chipSize = 10000;
        this.chipOffsetX = 400;
        this.chipOffsetY = 0;
    }
    
    /**
     * Initialize the WebGPU renderer
     * @returns {Promise<boolean>} True if initialization was successful
     */
    async init() {
        // Check WebGPU support
        if (!navigator.gpu) {
            console.error('WebGPU is not supported in this browser');
            return false;
        }
        
        try {
            // Request adapter and device
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                console.error('Failed to get WebGPU adapter');
                return false;
            }
            
            this.device = await adapter.requestDevice();
            
            // Configure canvas context
            this.context = this.canvas.getContext('webgpu');
            const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
            this.context.configure({
                device: this.device,
                format: preferredFormat,
                alphaMode: 'premultiplied',
            });
            
            // Parse segdefs and create vertex buffer
            this.parseSegdefs();
            
            // Create textures (placeholder or loaded from URLs)
            await this.createTextures();
            
            // Create pipeline and buffers
            this.createBuffers();
            this.createPipeline(preferredFormat);
            this.createBindGroup();
            
            return true;
        } catch (error) {
            console.error('Failed to initialize WebGPU:', error);
            return false;
        }
    }
    
    /**
     * Parse segdefs into vertex buffer data with triangulation
     * Segdef format: [nodeIndex, pullupChar, layerType, x1, y1, x2, y2, ...]
     */
    parseSegdefs() {
        const vertices = [];
        let maxNodeIndex = 0;
        
        for (const seg of this.segdefs) {
            const nodeIndex = seg[0];
            const layerType = seg[2];
            
            // Track max node index for buffer sizing
            if (nodeIndex > maxNodeIndex) {
                maxNodeIndex = nodeIndex;
            }
            
            // Extract polygon coordinates (starting at index 3)
            const coords = seg.slice(3);
            if (coords.length < 6) continue; // Need at least 3 vertices
            
            // Convert polygon coordinates to triangles using fan triangulation
            const triangleVertices = this.triangulatePolygon(coords, nodeIndex, layerType);
            vertices.push(...triangleVertices);
        }
        
        this.nodeCount = maxNodeIndex + 1;
        this.vertices = new Float32Array(vertices);
        this.vertexCount = vertices.length / 5; // 5 floats per vertex: x, y, u, v, nodeIndex packed with layerType
    }
    
    /**
     * Triangulate a polygon using fan triangulation
     * @param {number[]} coords - Flat array of x,y coordinates
     * @param {number} nodeIndex - Node index for this polygon
     * @param {number} layerType - Layer type (0=metal, 1=diffusion, etc.)
     * @returns {number[]} Array of vertex data
     */
    triangulatePolygon(coords, nodeIndex, layerType) {
        const vertices = [];
        const numPoints = coords.length / 2;
        
        if (numPoints < 3) return vertices;
        
        // Calculate bounding box for UV mapping
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        
        for (let i = 0; i < coords.length; i += 2) {
            minX = Math.min(minX, coords[i]);
            maxX = Math.max(maxX, coords[i]);
            minY = Math.min(minY, coords[i + 1]);
            maxY = Math.max(maxY, coords[i + 1]);
        }
        
        const width = maxX - minX || 1;
        const height = maxY - minY || 1;
        
        // Fan triangulation from first vertex
        const x0 = coords[0];
        const y0 = coords[1];
        const u0 = (x0 - minX) / width;
        const v0 = (y0 - minY) / height;
        
        for (let i = 1; i < numPoints - 1; i++) {
            const x1 = coords[i * 2];
            const y1 = coords[i * 2 + 1];
            const x2 = coords[(i + 1) * 2];
            const y2 = coords[(i + 1) * 2 + 1];
            
            // UV coordinates based on position in bounding box
            const u1 = (x1 - minX) / width;
            const v1 = (y1 - minY) / height;
            const u2 = (x2 - minX) / width;
            const v2 = (y2 - minY) / height;
            
            // Normalize chip coordinates to clip space (-1 to 1)
            const nx0 = this.normalizeX(x0);
            const ny0 = this.normalizeY(y0);
            const nx1 = this.normalizeX(x1);
            const ny1 = this.normalizeY(y1);
            const nx2 = this.normalizeX(x2);
            const ny2 = this.normalizeY(y2);
            
            // Pack nodeIndex and layerType into vertex data
            // Vertex format: x, y, u, v, packedData
            // packedData: lower 24 bits = nodeIndex, upper 8 bits = layerType
            // Clamp nodeIndex to 24 bits (max 16777215) to prevent overflow into layerType bits
            const clampedNodeIndex = nodeIndex & 0x00FFFFFF;
            const clampedLayerType = layerType & 0xFF;
            const packedData = clampedNodeIndex | (clampedLayerType << 24);
            
            // Triangle vertex 0
            vertices.push(nx0, ny0, u0, v0, packedData);
            // Triangle vertex 1
            vertices.push(nx1, ny1, u1, v1, packedData);
            // Triangle vertex 2
            vertices.push(nx2, ny2, u2, v2, packedData);
        }
        
        return vertices;
    }
    
    /**
     * Normalize X coordinate from chip space to clip space
     * @param {number} x - X coordinate in chip space
     * @returns {number} Normalized X in range [-1, 1]
     */
    normalizeX(x) {
        return ((x + this.chipOffsetX) / this.chipSize) * 2.0 - 1.0;
    }
    
    /**
     * Normalize Y coordinate from chip space to clip space
     * @param {number} y - Y coordinate in chip space  
     * @returns {number} Normalized Y in range [-1, 1]
     */
    normalizeY(y) {
        // Flip Y because chip coordinates have Y increasing downward
        return 1.0 - ((y + this.chipOffsetY) / this.chipSize) * 2.0;
    }
    
    /**
     * Create WebGPU buffers
     */
    createBuffers() {
        // Vertex buffer
        this.vertexBuffer = this.device.createBuffer({
            size: this.vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.vertexBuffer, 0, this.vertices);
        
        // Uniform buffer (time, zoomLevel, pan.x, pan.y)
        this.uniformBuffer = this.device.createBuffer({
            size: 16, // 4 floats * 4 bytes
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        // Node state storage buffer
        // Initialize all states to 0.0 (low)
        // WebGPU requires a minimum buffer size of 4 bytes for storage buffers
        const MIN_STORAGE_BUFFER_SIZE = 4;
        const initialStates = new Float32Array(this.nodeCount);
        this.nodeStateBuffer = this.device.createBuffer({
            size: Math.max(initialStates.byteLength, MIN_STORAGE_BUFFER_SIZE),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.nodeStateBuffer, 0, initialStates);
    }
    
    /**
     * Create placeholder textures or load from URLs
     */
    async createTextures() {
        // Create sampler
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
        });
        
        // Create or load substrate texture
        if (this.substrateTextureUrl) {
            this.substrateTexture = await this.loadTexture(this.substrateTextureUrl);
        } else {
            this.substrateTexture = this.createPlaceholderTexture([40, 40, 50, 255]); // Dark metallic
        }
        
        // Create or load active texture
        if (this.activeTextureUrl) {
            this.activeTexture = await this.loadTexture(this.activeTextureUrl);
        } else {
            this.activeTexture = this.createPlaceholderTexture([0, 255, 200, 255]); // Cyan glow
        }
    }
    
    /**
     * Create a placeholder solid color texture
     * @param {number[]} color - RGBA color values (0-255)
     * @returns {GPUTexture}
     */
    createPlaceholderTexture(color) {
        const texture = this.device.createTexture({
            size: [1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        
        const data = new Uint8Array(color);
        this.device.queue.writeTexture(
            { texture },
            data,
            { bytesPerRow: 4 },
            { width: 1, height: 1 }
        );
        
        return texture;
    }
    
    /**
     * Load a texture from a URL
     * @param {string} url - Texture URL
     * @returns {Promise<GPUTexture>}
     */
    async loadTexture(url) {
        const response = await fetch(url);
        const blob = await response.blob();
        const imageBitmap = await createImageBitmap(blob);
        
        const texture = this.device.createTexture({
            size: [imageBitmap.width, imageBitmap.height],
            format: 'rgba8unorm',
            // Only TEXTURE_BINDING and COPY_DST needed for sampling textures
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        
        this.device.queue.copyExternalImageToTexture(
            { source: imageBitmap },
            { texture },
            [imageBitmap.width, imageBitmap.height]
        );
        
        return texture;
    }
    
    /**
     * Get the WGSL shader code
     * @returns {string}
     */
    getShaderCode() {
        return `
@group(0) @binding(0) var substrateSampler: sampler;
@group(0) @binding(1) var substrateTexture: texture_2d<f32>;
@group(0) @binding(2) var activeTexture: texture_2d<f32>;

struct Uniforms {
    time: f32,
    zoomLevel: f32,
    pan: vec2<f32>,
};
@group(0) @binding(3) var<uniform> uniforms: Uniforms;

// Node state array - stores high/low state for each node
@group(0) @binding(4) var<storage, read> nodeStates: array<f32>;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) packedData: u32,  // nodeIndex (lower 24 bits) + layerType (upper 8 bits)
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) signalState: f32,
    @location(2) vLayer: f32,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    
    // Unpack nodeIndex and layerType
    let nodeIndex = in.packedData & 0x00FFFFFFu;
    let layerType = f32((in.packedData >> 24u) & 0xFFu);
    
    // Retrieve state from storage buffer based on node index
    var state: f32 = 0.0;
    if (nodeIndex < arrayLength(&nodeStates)) {
        state = nodeStates[nodeIndex];
    }
    
    // Apply zoom and pan transformations
    let worldPos = (in.position + uniforms.pan) * uniforms.zoomLevel;
    
    out.position = vec4<f32>(worldPos, 0.0, 1.0);
    out.uv = in.uv;
    out.signalState = state;
    out.vLayer = layerType;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let coldColor = textureSample(substrateTexture, substrateSampler, in.uv);
    let flowUV = in.uv + vec2<f32>(uniforms.time * 0.1, 0.0);
    let hotColor = textureSample(activeTexture, substrateSampler, flowUV);

    let signalIntensity = smoothstep(0.2, 0.8, in.signalState);
    var finalColor = mix(coldColor.rgb, hotColor.rgb * 2.5, signalIntensity);

    // Tint based on layer type
    if (in.vLayer < 0.5) { // Metal layer (layer 0)
        finalColor = finalColor * vec3<f32>(0.7, 0.7, 1.0); // Slight blue tint
    } else if (in.vLayer < 1.5) { // Diffusion (layer 1)
        finalColor = finalColor * vec3<f32>(0.8, 1.0, 0.8); // Green tint
    } else if (in.vLayer > 4.5) { // Polysilicon (layer 5)
        finalColor = finalColor * vec3<f32>(1.0, 0.8, 0.8); // Red tint
    }

    return vec4<f32>(finalColor, 1.0);
}
`;
    }
    
    /**
     * Create the render pipeline
     * @param {GPUTextureFormat} format - The canvas texture format
     */
    createPipeline(format) {
        const shaderModule = this.device.createShaderModule({
            code: this.getShaderCode(),
        });
        
        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 20, // 5 floats * 4 bytes
                    attributes: [
                        { // position
                            shaderLocation: 0,
                            offset: 0,
                            format: 'float32x2',
                        },
                        { // uv
                            shaderLocation: 1,
                            offset: 8,
                            format: 'float32x2',
                        },
                        { // packedData (nodeIndex + layerType)
                            shaderLocation: 2,
                            offset: 16,
                            format: 'uint32',
                        },
                    ],
                }],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: format,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });
    }
    
    /**
     * Create the bind group for resources
     */
    createBindGroup() {
        this.bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: this.substrateTexture.createView() },
                { binding: 2, resource: this.activeTexture.createView() },
                { binding: 3, resource: { buffer: this.uniformBuffer } },
                { binding: 4, resource: { buffer: this.nodeStateBuffer } },
            ],
        });
    }
    
    /**
     * Update node states from the simulator's nodes array
     * @param {Array|Object} nodes - The simulator's nodes array or object
     */
    updateNodeStates(nodes) {
        if (!this.device || !this.nodeStateBuffer) return;
        
        const states = new Float32Array(this.nodeCount);
        
        // Handle both array and object formats
        if (Array.isArray(nodes)) {
            for (let i = 0; i < Math.min(nodes.length, this.nodeCount); i++) {
                if (nodes[i] && nodes[i].state !== undefined) {
                    states[i] = nodes[i].state ? 1.0 : 0.0;
                }
            }
        } else {
            // Object with numeric keys
            for (const key in nodes) {
                const idx = parseInt(key, 10);
                if (!isNaN(idx) && idx < this.nodeCount && nodes[key]) {
                    states[idx] = nodes[key].state ? 1.0 : 0.0;
                }
            }
        }
        
        this.device.queue.writeBuffer(this.nodeStateBuffer, 0, states);
    }
    
    /**
     * Update uniform values
     * @param {Object} options
     * @param {number} [options.time] - Animation time
     * @param {number} [options.zoomLevel] - Zoom level
     * @param {number[]} [options.pan] - Pan offset [x, y]
     */
    updateUniforms(options = {}) {
        if (options.time !== undefined) this.time = options.time;
        if (options.zoomLevel !== undefined) this.zoomLevel = options.zoomLevel;
        if (options.pan !== undefined) this.pan = options.pan;
        
        const uniformData = new Float32Array([
            this.time,
            this.zoomLevel,
            this.pan[0],
            this.pan[1],
        ]);
        
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
    }
    
    /**
     * Render a single frame
     */
    render() {
        if (!this.device || !this.pipeline || this.vertexCount === 0) return;
        
        // Update time uniform
        this.updateUniforms({ time: this.time });
        
        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();
        
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.02, g: 0.02, b: 0.05, a: 1.0 }, // Dark background
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        
        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.setVertexBuffer(0, this.vertexBuffer);
        renderPass.draw(this.vertexCount);
        renderPass.end();
        
        this.device.queue.submit([commandEncoder.finish()]);
    }
    
    /**
     * Start the render loop
     * @param {Array|Object} [nodes] - Optional reference to simulator nodes for state updates
     */
    start(nodes) {
        if (this.isRunning) return;
        this.isRunning = true;
        
        const animate = () => {
            if (!this.isRunning) return;
            
            this.time += 0.016; // ~60fps time increment
            
            // Update node states if nodes reference provided
            if (nodes) {
                this.updateNodeStates(nodes);
            }
            
            this.render();
            this.animationFrameId = requestAnimationFrame(animate);
        };
        
        animate();
    }
    
    /**
     * Stop the render loop
     */
    stop() {
        this.isRunning = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }
    
    /**
     * Set zoom level
     * @param {number} level - Zoom level (1.0 = default)
     */
    setZoom(level) {
        this.zoomLevel = Math.max(0.1, Math.min(level, 20.0));
        this.updateUniforms({ zoomLevel: this.zoomLevel });
    }
    
    /**
     * Set pan offset
     * @param {number} x - X pan offset
     * @param {number} y - Y pan offset
     */
    setPan(x, y) {
        this.pan = [x, y];
        this.updateUniforms({ pan: this.pan });
    }
    
    /**
     * Clean up resources
     */
    destroy() {
        this.stop();
        
        if (this.vertexBuffer) this.vertexBuffer.destroy();
        if (this.uniformBuffer) this.uniformBuffer.destroy();
        if (this.nodeStateBuffer) this.nodeStateBuffer.destroy();
        if (this.substrateTexture) this.substrateTexture.destroy();
        if (this.activeTexture) this.activeTexture.destroy();
        
        this.device = null;
        this.context = null;
    }
    
    /**
     * Load custom textures after initialization
     * @param {string} substrateUrl - URL for substrate texture
     * @param {string} activeUrl - URL for active texture
     */
    async loadCustomTextures(substrateUrl, activeUrl) {
        if (substrateUrl) {
            if (this.substrateTexture) this.substrateTexture.destroy();
            this.substrateTexture = await this.loadTexture(substrateUrl);
        }
        
        if (activeUrl) {
            if (this.activeTexture) this.activeTexture.destroy();
            this.activeTexture = await this.loadTexture(activeUrl);
        }
        
        // Recreate bind group with new textures
        this.createBindGroup();
    }
    
    /**
     * Resize the canvas and update rendering
     * @param {number} width - New width
     * @param {number} height - New height
     */
    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        
        // Context needs to be reconfigured after resize
        if (this.context && this.device) {
            this.context.configure({
                device: this.device,
                format: navigator.gpu.getPreferredCanvasFormat(),
                alphaMode: 'premultiplied',
            });
        }
    }
}

// Export for use as ES module or global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WebGPURenderer;
} else if (typeof window !== 'undefined') {
    window.WebGPURenderer = WebGPURenderer;
}
