#!/usr/bin/env python3
"""
LAYA-MLX Native Server for SimpleUI
Optimized for Apple Silicon via MLX. Exposes POST /v1/systemone on port 1236.
"""

import sys
import json
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler

logging.basicConfig(level=logging.INFO, format='[Laya-MLX] %(asctime)s - %(message)s')
logger = logging.getLogger(__name__)

PORT = 1236
agent = None

def init_agent():
    global agent
    if agent is not None:
        return agent
    try:
        import laya_mlx
        logger.info("Loading LAYA multilingual decision model via Apple Silicon MLX...")
        agent = laya_mlx.load(subfolder='multilingual')
        logger.info("LAYA multilingual model successfully loaded on Metal GPU!")
        return agent
    except Exception as e:
        logger.error(f"Failed to load laya_mlx agent: {e}")
        return None

class LayaHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress verbose standard HTTP access logs
        pass

    def _send_json(self, status_code, data):
        response_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()
        self.wfile.write(response_bytes)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health' or self.path == '/':
            self._send_json(200, {
                'status': 'healthy',
                'engine': 'laya-mlx',
                'device': 'apple-silicon-metal',
                'ready': agent is not None
            })
            return
        self._send_json(404, {'error': 'Not Found'})

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            self._send_json(400, {'error': 'Invalid JSON body'})
            return

        # 1. Native LAYA / Jev System 1 API
        if self.path == '/v1/systemone':
            state = payload.get('state', '')
            questions = payload.get('questions', {})
            
            if not state or not questions:
                self._send_json(400, {'error': 'Missing state or questions'})
                return

            if agent is None:
                self._send_json(503, {'error': 'LAYA model is not ready yet'})
                return

            try:
                res = agent.predict(state, questions)
                self._send_json(200, res)
            except Exception as e:
                logger.error(f"Prediction error: {e}")
                self._send_json(500, {'error': str(e)})
            return

        # 2. OpenAI-compatible /v1/chat/completions fallback wrapper
        if self.path == '/v1/chat/completions':
            messages = payload.get('messages', [])
            prompt = messages[-1].get('content', '') if messages else ''
            
            # Simple decision parser
            if agent is not None:
                try:
                    res = agent.predict(prompt, {'decision': {'type': 'noul'}})
                    is_yes = res.get('decision', {}).get('choice', '') == 'yes'
                    text = 'YES' if is_yes else 'NO'
                except Exception:
                    text = 'YES'
            else:
                text = 'YES'

            self._send_json(200, {
                'id': 'chatcmpl-laya',
                'object': 'chat.completion',
                'choices': [{
                    'index': 0,
                    'message': {'role': 'assistant', 'content': text},
                    'finish_reason': 'stop'
                }]
            })
            return

        self._send_json(404, {'error': f"Unknown endpoint: {self.path}"})

def run():
    init_agent()
    server = HTTPServer(('127.0.0.1', PORT), LayaHandler)
    logger.info(f"🚀 LAYA-MLX Server running at http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Stopping LAYA-MLX server...")
        server.server_close()

if __name__ == '__main__':
    run()
