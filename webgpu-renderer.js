/**
 * WebGPU Renderer for Visual6502
 * Features:
 * - Robust "Ear Clipping" triangulation for complex concave chip polygons.
 * - Procedural "Cyber-Silicon" textures (No images required).
 * - High-performance Storage Buffer for node states.
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

        // 1. Process Geometry (Now with Triangulation)
        const vertices = this.processGeometry(segdefs);
        this.vertexCount = vertices.length / 4; 

        // 2. Create Vertex Buffer
        this.vertexBuffer = this.device.createBuffer({
            label: "Chip Geometry Buffer",
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.vertexBuffer.getMappedRange()).set(vertices);
        this.vertexBuffer.unmap();

        // 3. Create Node State Buffer
        // Max 6502 nodes ~4000. 
        this.nodeStateBuffer = this.device.createBuffer({
            label: "Node State Buffer",
            size: 10000 * 4, // Safety margin
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // 4. Create Uniform Buffer
        this.uniformBuffer = this.device.createBuffer({
            label: "Uniform Buffer",
            size: 64, 
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // 5. Generate Textures
        this.substrateTexture = this.createProceduralTexture(0); 
        this.activeTexture = this.createProceduralTexture(1);    
        
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

        // Step B: Triangulate Polygons
        const allVertices = [];
        
        for (let i = 0; i < segdefs.length; i++) {
            const seg = segdefs[i];
            const nodeIndex = seg[0];
            const layer = seg[2]; 
            
            // Extract raw polygon path
            const path = [];
            for (let j = 3; j < seg.length; j += 2) {
                const nx = (seg[j] - this.bounds.minX) / this.bounds.width;
                const ny = (seg[j+1] - this.bounds.minY) / this.bounds.height;
                // Flip Y for rendering
                path.push({ x: nx, y: 1.0 - ny });
            }

            // Run Ear Clipping Algorithm
            const triangles = this.triangulate(path);

            // Push vertices to buffer array
            for(let t=0; t<triangles.length; t++) {
                const v = triangles[t];
                allVertices.push(v.x, v.y, nodeIndex, layer);
            }
        }

        return new Float32Array(allVertices);
    }

    // A robust Ear Clipping implementation to handle concave polygons
    triangulate(path) {
        if (path.length < 3) return [];

        // 1. Ensure Counter-Clockwise (CCW) winding
        let area = 0;
        for (let i = 0; i < path.length; i++) {
            const j = (i + 1) % path.length;
            area += (path[j].x - path[i].x) * (path[j].y + path[i].y);
        }
        // If area is positive (in this coordinate system), it might be CW. 
        // We clone and reverse if needed.
        let rings = (area > 0) ? path.slice().reverse() : path.slice();
        
        const triangles = [];
        let remaining = rings.length;
        
        // Safety: Prevent infinite loop on bad geometry
        let iterations = 0;
        const maxIterations = remaining * remaining * 2; 

        while (remaining > 3 && iterations < maxIterations) {
            iterations++;
            let earFound = false;

            for (let i = 0; i < remaining; i++) {
                const prev = (i - 1 + remaining) % remaining;
                const next = (i + 1) % remaining;
                
                const v0 = rings[prev];
                const v1 = rings[i];
                const v2 = rings[next];

                // Check convexity (Cross Product)
                const cp = (v1.x - v0.x) * (v2.y - v1.y) - (v1.y - v0.y) * (v2.x - v1.x);
                
                if (cp >= 0) { // Convex vertex
                    // Check if any other point is inside this triangle
                    let isEar = true;
                    for (let j = 0; j < remaining; j++) {
                        if (j === prev || j === i || j === next) continue;
                        if (this.isPointInTriangle(rings[j], v0, v1, v2)) {
                            isEar = false;
                            break;
                        }
                    }

                    if (isEar) {
                        triangles.push(v0, v1, v2);
                        rings.splice(i, 1);
                        remaining--;
                        earFound = true;
                        break;
                    }
                }
            }
            if (!earFound) break; // Should not happen for valid simple polygons
        }
        
        // Add the final triangle
        if (remaining === 3) {
            triangles.push(rings[0], rings[1], rings[2]);
        }
        
        return triangles;
    }

    isPointInTriangle(p, a, b, c) {
        const cross = (o, k, m) => (k.x - o.x) * (m.y - o.y) - (k.y - o.y) * (m.x - o.x);
        const cp1 = cross(a, b, p);
        const cp2 = cross(b, c, p);
        const cp3 = cross(c, a, p);
        // Point is inside if all cross products have the same sign
        return (cp1 >= 0 && cp2 >= 0 && cp3 >= 0) || (cp1 <= 0 && cp2 <= 0 && cp3 <= 0);
    }

    createProceduralTexture(type) {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        if (type === 0) { // Substrate (Cold)
            // Dark oxidized metal
            ctx.fillStyle = '#0a0a10';
            ctx.fillRect(0,0,size,size);
            
            // Texture noise
            for(let i=0; i<8000; i++) {
                ctx.fillStyle = `rgba(150, 150, 160, ${Math.random()*0.05})`;
                const s = Math.random()*2 + 1;
                ctx.fillRect(Math.random()*size, Math.random()*size, s, s);
            }
            
            // Micro-circuit grid pattern
            ctx.strokeStyle = 'rgba(255,255,255,0.03)';
            ctx.lineWidth = 1;
            for(let i=0; i<size; i+=32) {
                ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,size); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0,i); ctx.lineTo(size,i); ctx.stroke();
            }
        } else { // Active (Hot)
            ctx.fillStyle = '#000000';
            ctx.fillRect(0,0,size,size);
            
            // Neon plasma gradients
            const grad = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size);
            grad.addColorStop(0, '#ff0055');
            grad.addColorStop(0.4, '#aa00ff');
            grad.addColorStop(1, '#000000');
            ctx.fillStyle = grad;
            ctx.fillRect(0,0,size,size);
            
            // Electric bolts
            ctx.strokeStyle = '#ffddaa';
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            for(let i=0; i<20; i++) {
                ctx.beginPath();
                ctx.moveTo(Math.random()*size, Math.random()*size);
                for(let j=0; j<5; j++) {
                    ctx.lineTo(Math.random()*size, Math.random()*size);
                }
                ctx.stroke();
            }
        }

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
                
                let worldPos = (in.position + uniforms.pan) * uniforms.zoom;
                let centered = (worldPos - 0.5) * 2.0; 
                
                // Flip Y to match Canvas coords
                out.position = vec4<f32>(centered.x, -centered.y, 0.0, 1.0);
                
                out.uv = in.position;
                
                // Fetch State safely
                let idx = u32(in.nodeIdx);
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
                // Background Metal
                let cold = textureSample(substrateTex, substrateSampler, in.uv * 4.0);
                
                // Flowing Energy
                let flow = vec2<f32>(uniforms.time * 0.15, sin(uniforms.time * 0.5) * 0.05);
                let hot = textureSample(activeTex, substrateSampler, (in.uv * 4.0) + flow);
                
                // Intensity Curve
                let intensity = smoothstep(0.3, 0.9, in.state);
                
                // Material/Layer Tints
                var tint = vec3<f32>(1.0);
                if (in.layer < 0.5) { 
                    tint = vec3<f32>(0.6, 0.8, 1.0); // Metal (Blue-ish)
                } else if (in.layer < 1.5) { 
                    tint = vec3<f32>(1.0, 0.2, 0.2); // Polysilicon (Red)
                } else { 
                    tint = vec3<f32>(0.2, 1.0, 0.4); // Diffusion (Green)
                }
                
                // Combine: Metal base + (Energy * Tint * Intensity)
                // Added a 'bloom' cheat by multiplying by 2.5
                let color = mix(cold.rgb * 0.4, hot.rgb * 2.5 * tint, intensity);
                
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
                    arrayStride: 16, 
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
        
        const data = new Float32Array(nodes.length);
        for(let i=0; i<nodes.length; i++) {
            // Handle both array[i] = 0/1 and array[i] = boolean
            const val = nodes[i];
            data[i] = (val && val > 0) ? 1.0 : 0.0;
        }

        this.device.queue.writeBuffer(this.nodeStateBuffer, 0, data);
    }

    render(time, zoom, panX, panY) {
        if (!this.isReady || !this.pipeline) return;

        const uniforms = new Float32Array([time, zoom, panX, panY]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: { r: 0.02, g: 0.02, b: 0.05, a: 1.0 },
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
