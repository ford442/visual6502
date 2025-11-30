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
            // FIXED: Added @location(0) to the return type
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
