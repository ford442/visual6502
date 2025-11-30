/**
 * WebGPU Renderer for Visual6502
 * v3.1 - Fixed WGSL Reserved Keyword Bug
 */
class WebGPURenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.device = null;
        this.context = null;
        this.pipeline = null;
        
        this.vertexBuffer = null;
        this.nodeStateBuffer = null;
        this.uniformBuffer = null;
        this.vertexCount = 0;

        this.substrateTexture = null;
        this.activeTexture = null;
        this.sampler = null;
        this.bindGroup = null;

        this.aspectRatio = 1.0;
        this.isReady = false;
        
        // Chip physical bounds
        this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, width: 1, height: 1 };
    }

    async init(segdefs) {
        if (!navigator.gpu) throw new Error("WebGPU not supported.");

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("No WebGPU adapter found.");

        this.device = await adapter.requestDevice();
        this.context = this.canvas.getContext('webgpu');
        this.format = navigator.gpu.getPreferredCanvasFormat();

        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'premultiplied',
        });

        // 1. Process Geometry using Earcut
        const vertices = this.processGeometry(segdefs);
        this.vertexCount = vertices.length / 4; 

        // 2. Create Vertex Buffer
        this.vertexBuffer = this.device.createBuffer({
            label: "Chip Geometry",
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.vertexBuffer.getMappedRange()).set(vertices);
        this.vertexBuffer.unmap();

        // 3. Buffers for State and Uniforms
        this.nodeStateBuffer = this.device.createBuffer({
            size: 20000 * 4, // Enough for 6502 nodes
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.uniformBuffer = this.device.createBuffer({
            size: 64, 
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // 4. Textures
        this.substrateTexture = this.createProceduralTexture(0); 
        this.activeTexture = this.createProceduralTexture(1);    
        
        this.sampler = this.device.createSampler({
            magFilter: 'linear', minFilter: 'linear',
            addressModeU: 'repeat', addressModeV: 'repeat'
        });

        await this.createPipeline();
        this.resize(this.canvas.width, this.canvas.height);
        this.isReady = true;
    }

    processGeometry(segdefs) {
        // A. Calculate Bounds
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

        // B. Sort Segments by Layer (Diffusion < Poly < Metal)
        // This ensures the metal wires draw ON TOP of the silicon
        // seg[2] is layer index.
        const sortedSegs = [...segdefs].sort((a, b) => a[2] - b[2]);

        // C. Triangulate using Earcut
        const allVertices = [];
        
        for (let i = 0; i < sortedSegs.length; i++) {
            const seg = sortedSegs[i];
            const nodeIndex = seg[0];
            const layer = seg[2]; 
            
            const coords = [];
            // Extract raw coords
            for (let j = 3; j < seg.length; j += 2) {
                const nx = (seg[j] - this.bounds.minX) / this.bounds.width;
                const ny = (seg[j+1] - this.bounds.minY) / this.bounds.height;
                coords.push(nx, 1.0 - ny); // Flip Y
            }

            // Earcut returns an array of indices [0,1,2, 0,2,3...]
            const indices = window.earcut(coords);

            for (let k = 0; k < indices.length; k++) {
                const idx = indices[k];
                const x = coords[idx * 2];
                const y = coords[idx * 2 + 1];
                
                // Push vertex: x, y, nodeIndex, layer
                allVertices.push(x, y, nodeIndex, layer);
            }
        }

        return new Float32Array(allVertices);
    }

    resize(w, h) {
        this.aspectRatio = w / h;
    }

    createProceduralTexture(type) {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');

        if (type === 0) { // Substrate (Cold Metal)
            ctx.fillStyle = '#101015'; ctx.fillRect(0,0,size,size);
            // Noise
            for(let i=0; i<10000; i++) {
                ctx.fillStyle = `rgba(150,150,170,${Math.random()*0.08})`;
                ctx.fillRect(Math.random()*size, Math.random()*size, 2, 2);
            }
            // Grid
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            for(let i=0; i<size; i+=64) {
                ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,size); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0,i); ctx.lineTo(size,i); ctx.stroke();
            }
        } else { // Active (Neon)
            ctx.fillStyle = '#000'; ctx.fillRect(0,0,size,size);
            // Plasma
            const g = ctx.createRadialGradient(size/2,size/2,0, size/2,size/2,size);
            g.addColorStop(0, '#ff0066'); g.addColorStop(0.5, '#9900ff'); g.addColorStop(1, '#000');
            ctx.fillStyle = g; ctx.fillRect(0,0,size,size);
        }

        const tex = this.device.createTexture({
            size: [size, size], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.device.queue.writeTexture(
            { texture: tex }, ctx.getImageData(0,0,size,size).data,
            { bytesPerRow: size*4 }, [size,size]
        );
        return tex;
    }

    async createPipeline() {
        const shader = `
            struct Uniforms { time: f32, zoom: f32, pan: vec2<f32>, aspect: f32 };
            @group(0) @binding(0) var<uniform> u: Uniforms;
            @group(0) @binding(1) var<storage, read> nodes: array<f32>;
            @group(0) @binding(2) var samp: sampler;
            @group(0) @binding(3) var texBase: texture_2d<f32>;
            @group(0) @binding(4) var texHot: texture_2d<f32>;

            struct VSOut {
                @builtin(position) pos: vec4<f32>,
                @location(0) uv: vec2<f32>,
                @location(1) state: f32,
                @location(2) layer: f32,
            };

            @vertex
            fn vs_main(@location(0) pos: vec2<f32>, @location(1) nIdx: f32, @location(2) layer: f32) -> VSOut {
                var out: VSOut;
                
                // View Transform
                let world = (pos + u.pan) * u.zoom;
                let centered = (world - 0.5) * 2.0;
                
                // Aspect Correction (Fit width)
                // If canvas is wider than tall, y coords need scaling to not look squashed
                var finalPos = vec2<f32>(centered.x, -centered.y);
                if (u.aspect > 1.0) {
                    finalPos.x = finalPos.x / u.aspect;
                } else {
                    finalPos.y = finalPos.y * u.aspect;
                }

                out.pos = vec4<f32>(finalPos, 0.0, 1.0);
                out.uv = pos;
                
                let i = u32(nIdx);
                if (i < arrayLength(&nodes)) { out.state = nodes[i]; } else { out.state = 0.0; }
                
                out.layer = layer;
                return out;
            }

            @fragment
            fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
                let base = textureSample(texBase, samp, in.uv * 4.0);
                let flow = vec2<f32>(u.time * 0.1, 0.0);
                let hot = textureSample(texHot, samp, (in.uv * 4.0) + flow);
                
                // RENAMED 'active' to 'signalIntensity'
                let signalIntensity = smoothstep(0.1, 0.9, in.state);
                
                var tint = vec3<f32>(1.0);
                if (in.layer < 0.5) { tint = vec3<f32>(0.5, 0.7, 1.0); }      // Metal
                else if (in.layer < 1.5) { tint = vec3<f32>(1.0, 0.3, 0.2); } // Poly
                else { tint = vec3<f32>(0.2, 1.0, 0.5); }                     // Diffusion

                let final = mix(base.rgb * 0.5, hot.rgb * 2.5 * tint, signalIntensity);
                return vec4<f32>(final, 1.0);
            }
        `;

        const module = this.device.createShaderModule({ code: shader });

        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: module, entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 16,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                        { shaderLocation: 1, offset: 8, format: 'float32' },
                        { shaderLocation: 2, offset: 12, format: 'float32' }
                    ]
                }]
            },
            fragment: {
                module: module, entryPoint: 'fs_main',
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
        for(let i=0; i<nodes.length; i++) data[i] = nodes[i] ? 1.0 : 0.0;
        this.device.queue.writeBuffer(this.nodeStateBuffer, 0, data);
    }

    render(time, zoom, panX, panY) {
        if (!this.isReady || !this.pipeline) return;

        // Add aspect ratio to uniforms
        const uniforms = new Float32Array([time, zoom, panX, panY, this.aspectRatio, 0, 0, 0]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: { r: 0.02, g: 0.02, b: 0.03, a: 1.0 },
                loadOp: 'clear', storeOp: 'store'
            }]
        });

        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.setVertexBuffer(0, this.vertexBuffer);
        pass.draw(this.vertexCount);
        pass.end();

        this.device.queue.submit([encoder.finish()]);
    }
}
