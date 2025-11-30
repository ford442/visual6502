/**
 * WebGPU Renderer for Visual6502
 * Handles geometry parsing, triangulation, and shader execution.
 */
class WebGPURenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.device = null;
        this.context = null;
        this.pipeline = null;
        
        // Buffers
        this.vertexBuffer = null;
        this.nodeStateBuffer = null;
        this.uniformBuffer = null;
        this.vertexCount = 0;

        // Textures
        this.substrateTexture = null;
        this.activeTexture = null;
        this.sampler = null;
        this.bindGroup = null;

        // State
        this.isReady = false;
        this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, width: 1, height: 1 };
    }

    async init(segdefs) {
        if (!navigator.gpu) {
            throw new Error("WebGPU not supported on this browser.");
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("No WebGPU adapter found.");
        }

        this.device = await adapter.requestDevice();
        this.context = this.canvas.getContext('webgpu');
        this.format = navigator.gpu.getPreferredCanvasFormat();

        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'premultiplied',
        });

        console.log("WebGPU Device Initialized");

        // 1. Process Geometry (Convert segdefs to triangles)
        const vertices = this.processGeometry(segdefs);
        this.vertexCount = vertices.length / 4; // 4 floats per vertex

        // 2. Create Vertex Buffer
        this.vertexBuffer = this.device.createBuffer({
            label: "Chip Geometry Buffer",
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.vertexBuffer.getMappedRange()).set(vertices);
        this.vertexBuffer.unmap();

        // 3. Create Node State Buffer (Storage Buffer)
        // Max 6502 nodes is around ~4000. We allocate enough for safety.
        const maxNodes = 8000; 
        this.nodeStateBuffer = this.device.createBuffer({
            label: "Node State Buffer",
            size: maxNodes * 4, // 4 bytes per float
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // 4. Create Uniform Buffer (Time, Zoom, Pan)
        this.uniformBuffer = this.device.createBuffer({
            label: "Uniform Buffer",
            size: 64, // 4 floats * 4 bytes
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // 5. Generate Procedural Textures (So it works without external images)
        this.substrateTexture = this.createProceduralTexture(0); // Cold Metal
        this.activeTexture = this.createProceduralTexture(1);    // Hot Plasma
        
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat'
        });

        // 6. Create Pipeline
        await this.createPipeline();
        
        this.isReady = true;
        console.log(`Renderer Ready: ${this.vertexCount} vertices generated.`);
    }

    processGeometry(segdefs) {
        // Step A: Calculate Bounds
        for (let i = 0; i < segdefs.length; i++) {
            const seg = segdefs[i];
            // format: [nodeNum, pullup, layer, x1, y1, x2, y2, ...]
            for (let j = 3; j < seg.length; j += 2) {
                const x = seg[j];
                const y = seg[j+1];
                if (x < this.bounds.minX) this.bounds.minX = x;
                if (x > this.bounds.maxX) this.bounds.maxX = x;
                if (y < this.bounds.minY) this.bounds.minY = y;
                if (y > this.bounds.maxY) this.bounds.maxY = y;
            }
        }
        this.bounds.width = this.bounds.maxX - this.bounds.minX;
        this.bounds.height = this.bounds.maxY - this.bounds.minY;

        // Step B: Triangulate
        const allVertices = [];
        
        for (let i = 0; i < segdefs.length; i++) {
            const seg = segdefs[i];
            const nodeIndex = seg[0];
            const layer = seg[2]; // 0=Diffusion? 1=Poly? Check specific segdefs
            
            // Extract polygon path
            const path = [];
            for (let j = 3; j < seg.length; j += 2) {
                // Normalize coordinates to 0..1
                const nx = (seg[j] - this.bounds.minX) / this.bounds.width;
                const ny = (seg[j+1] - this.bounds.minY) / this.bounds.height;
                
                // Flip Y because WebGPU (and 6502 data usually) have different origins
                path.push({ x: nx, y: 1.0 - ny });
            }

            // Triangulate (Simple Fan for now - 6502 polys are mostly convex/rects)
            // For a production robust version, use Earcut. Here we use a fan which works for 95% of traces.
            // Triangles: 0-1-2, 0-2-3, 0-3-4...
            for (let k = 1; k < path.length - 1; k++) {
                const v0 = path[0];
                const v1 = path[k];
                const v2 = path[k+1];

                // Push vertices: [x, y, nodeIndex, layer]
                allVertices.push(v0.x, v0.y, nodeIndex, layer);
                allVertices.push(v1.x, v1.y, nodeIndex, layer);
                allVertices.push(v2.x, v2.y, nodeIndex, layer);
            }
        }

        return new Float32Array(allVertices);
    }

    createProceduralTexture(type) {
        // Generates a texture in memory so we don't need image files
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        if (type === 0) { // Substrate (Cold)
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0,0,size,size);
            // Add noise
            for(let i=0; i<5000; i++) {
                ctx.fillStyle = `rgba(100, 100, 120, ${Math.random()*0.1})`;
                ctx.fillRect(Math.random()*size, Math.random()*size, 2, 2);
            }
            // Add grid lines
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 1;
            for(let i=0; i<size; i+=20) {
                ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,size); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0,i); ctx.lineTo(size,i); ctx.stroke();
            }
        } else { // Active (Hot)
            ctx.fillStyle = '#000';
            ctx.fillRect(0,0,size,size);
            // Add plasma clouds
            const grad = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size);
            grad.addColorStop(0, '#ff0055');
            grad.addColorStop(0.5, '#aa00cc');
            grad.addColorStop(1, '#000000');
            ctx.fillStyle = grad;
            ctx.fillRect(0,0,size,size);
            // Add electric sparks
            ctx.strokeStyle = '#ffcc00';
            ctx.lineWidth = 2;
            for(let i=0; i<50; i++) {
                ctx.beginPath();
                ctx.moveTo(Math.random()*size, Math.random()*size);
                ctx.lineTo(Math.random()*size, Math.random()*size);
                ctx.stroke();
            }
        }

        // Upload to GPU
        const texture = this.device.createTexture({
            size: [size, size],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });

        const imageData = ctx.getImageData(0, 0, size, size);
        this.device.queue.writeTexture(
            { texture: texture },
            imageData.data,
            { bytesPerRow: size * 4 },
            [size, size]
        );
        return texture;
    }

    async createPipeline() {
        const shaderCode = `
            struct Uniforms {
                time: f32,
                zoom: f32,
                pan: vec2<f32>,
            };
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;
            @group(0) @binding(1) var<storage, read> nodeStates: array<f32>;
            @group(0) @binding(2) var substrateSampler: sampler;
            @group(0) @binding(3) var substrateTex: texture_2d<f32>;
            @group(0) @binding(4) var activeTex: texture_2d<f32>;

            struct VertexInput {
                @location(0) position: vec2<f32>,
                @location(1) nodeIdx: f32,
                @location(2) layer: f32,
            };

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
                @location(1) state: f32,
                @location(2) layer: f32,
            };

            @vertex
            fn vs_main(in: VertexInput) -> VertexOutput {
                var out: VertexOutput;
                // Simple View Transform
                let worldPos = (in.position + uniforms.pan) * uniforms.zoom;
                // Center it (approximate)
                let centered = (worldPos - 0.5) * 2.0; 
                
                // Aspect Ratio Fix (assume square canvas for simplicity or pass aspect)
                out.position = vec4<f32>(centered.x, -centered.y, 0.0, 1.0); // Flipped Y here
                
                // UVs match the normalized position
                out.uv = in.position;
                
                // Fetch State
                let idx = u32(in.nodeIdx);
                // Safety check for index bounds
                if (idx < arrayLength(&nodeStates)) {
                    out.state = nodeStates[idx];
                } else {
                    out.state = 0.0;
                }
                
                out.layer = in.layer;
                return out;
            }

            @fragment
            fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
                let cold = textureSample(substrateTex, substrateSampler, in.uv * 5.0); // Tiled
                
                // Animate hot texture
                let flow = vec2<f32>(uniforms.time * 0.2, 0.0);
                let hot = textureSample(activeTex, substrateSampler, (in.uv * 5.0) + flow);
                
                // Blend based on state
                let intensity = smoothstep(0.4, 0.6, in.state);
                
                // Layer tinting
                var tint = vec3<f32>(1.0);
                if (in.layer < 0.5) { tint = vec3<f32>(0.5, 0.8, 1.0); } // Metal
                else if (in.layer < 1.5) { tint = vec3<f32>(1.0, 0.3, 0.3); } // Poly
                else { tint = vec3<f32>(0.2, 1.0, 0.2); } // Diffusion
                
                let color = mix(cold.rgb * 0.5, hot.rgb * 2.0 * tint, intensity);
                
                return vec4<f32>(color, 1.0);
            }
        `;

        const module = this.device.createShaderModule({ code: shaderCode });

        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: module,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 16, // 4 * 4 bytes
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' }, // pos
                        { shaderLocation: 1, offset: 8, format: 'float32' },   // nodeIdx
                        { shaderLocation: 2, offset: 12, format: 'float32' },  // layer
                    ]
                }]
            },
            fragment: {
                module: module,
                entryPoint: 'fs_main',
                targets: [{ format: this.format }]
            },
            primitive: { topology: 'triangle-list' }
        });

        // Create Bind Group
        this.bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.nodeStateBuffer } },
                { binding: 2, resource: this.sampler },
                { binding: 3, resource: this.substrateTexture.createView() },
                { binding: 4, resource: this.activeTexture.createView() }
            ]
        });
    }

    updateNodeStates(nodes) {
        if (!this.isReady) return;
        
        // Convert JS node array (which might be sparse or objects) to flat Float32
        // Assumes 'nodes' is an array where index matches node number, or we need mapping.
        // For visual6502, we might need a mapping array if node IDs are non-contiguous.
        // Here we assume nodes[i] is the state (High/Low) of node ID i.
        
        // Optimization: Keep a persistent typed array and only upload when needed
        const data = new Float32Array(nodes.length);
        for(let i=0; i<nodes.length; i++) {
            // Visual6502 usually stores state as boolean or 0/1
            data[i] = nodes[i] ? 1.0 : 0.0;
        }

        this.device.queue.writeBuffer(this.nodeStateBuffer, 0, data);
    }

    render(time, zoom, panX, panY) {
        if (!this.isReady || !this.pipeline) return;

        // Update Uniforms
        const uniforms = new Float32Array([time, zoom, panX, panY]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: { r: 0.05, g: 0.05, b: 0.1, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }]
        });

        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, this.bindGroup);
        passEncoder.setVertexBuffer(0, this.vertexBuffer);
        passEncoder.draw(this.vertexCount);
        passEncoder.end();

        this.device.queue.submit([commandEncoder.finish()]);
    }
}
