const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

module.exports = {
    mode: 'production',
    entry: {
        offscreen: './src/offscreen/offscreen.js',
        'content-script': './src/content/content-script.js',
        'service-worker': './src/background/service-worker.js',
        'tts-worker': './src/worker/tts-worker.js',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        // Don't wipe the whole dist/ on rebuild — that would delete
        // dist/models/kokoro-v1.0.onnx which is copied separately via copy-model.
        clean: false,
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: ['@babel/preset-env'],
                    },
                },
            },
        ],
    },
    plugins: [
        // Inject Node.js + browser polyfills BEFORE the IIFE runs in the worker.
        // onnxruntime-web references __filename, __dirname, and window at
        // module-init time inside the pre-minified ort.min.js bundle.
        // The webpack `node` option doesn't substitute inside pre-minified files,
        // so we define the globals here in the banner (outside the IIFE) instead.
        new webpack.BannerPlugin({
            banner: [
                'if(typeof __filename==="undefined"){var __filename="/tts-worker.js";}',
                'if(typeof __dirname==="undefined"){var __dirname="/";}',
                'if(typeof window==="undefined"){self.window=self;self.document={createElement:function(){return{}}};}',
            ].join(''),
            raw: true,
            include: /tts-worker\.js$/,
        }),
        new CopyPlugin({
            patterns: [
                { from: 'src/manifest.json', to: 'manifest.json' },
                { from: 'src/offscreen/offscreen.html', to: 'offscreen.html' },
                { from: 'src/onboarding/onboarding.html', to: 'onboarding.html' },
                { from: 'src/onboarding/onboarding.js', to: 'onboarding.js' },
                { from: 'src/assets/icons', to: 'icons' },
                // ONNX Runtime WASM files — single-threaded only.
                // Multi-threaded ORT spawns sub-workers via blob: URLs which Chrome
                // blocks in extension workers. simd: primary, basic: fallback.
                { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm', to: 'wasm/[name][ext]' },
                { from: 'node_modules/onnxruntime-web/dist/ort-wasm.wasm', to: 'wasm/[name][ext]' },
                // NOTE: kokoro-v1.0.onnx and voices/ are no longer bundled.
                // They are downloaded from Hugging Face on first use and cached
                // in OPFS (Origin Private File System) for subsequent launches.
                // For local development only, you can still run:
                //   npm run copy-model   → copies kokoro-v1.0.onnx to dist/models/
                //   (copy voices manually to dist/models/voices/ if needed)
            ],
        }),
    ],
    resolve: {
        fallback: {
            fs: false,
            path: false,
            crypto: false,
        },
    },
    // Service workers cannot use eval-based source maps
    devtool: false,
};
