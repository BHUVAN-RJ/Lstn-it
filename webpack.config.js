const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

module.exports = {
    mode: 'production',
    entry: {
        popup: './src/popup/popup.js',
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
                { from: 'src/popup/popup.html', to: 'popup.html' },
                { from: 'src/popup/popup.css', to: 'popup.css' },
                { from: 'src/assets/icons', to: 'icons' },
                // Voice embeddings (14MB) — small enough to copy on every build
                { from: 'models/voices', to: 'models/voices' },
                // ONNX Runtime WASM files must be accessible at runtime
                {
                    from: 'node_modules/onnxruntime-web/dist/*.wasm',
                    to: 'wasm/[name][ext]',
                },
                // NOTE: kokoro-v1.0.onnx (310MB) is NOT copied here.
                // Run `npm run copy-model` once to copy it to dist/models/.
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
