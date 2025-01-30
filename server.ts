interface RateLimiter {
  requests: number;
  tokens: number;
  lastReset: number;
}

const rateLimiter: RateLimiter = {
  requests: 0,
  tokens: 0,
  lastReset: Date.now(),
};

function estimateTokens(body: any): number {
  try {
    const messages = body?.messages || [];
    return messages.reduce((acc: number, msg: any) => 
      acc + (msg.content?.length || 0) * 0.25, 0);
  } catch {
    return 0;
  }
}

function resetCountersIfNeeded() {
  const now = Date.now();
  if (now - rateLimiter.lastReset >= 60000) {
    rateLimiter.requests = 0;
    rateLimiter.tokens = 0;
    rateLimiter.lastReset = now;
  }
}

async function processResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    const jsonData = await response.json();
    
    if (jsonData.choices && jsonData.choices[0]?.message?.content) {
      const content = jsonData.choices[0].message.content;
      const processedContent = content.replace(/<think>.*?<\/think>\s*/s, '').trim();
      jsonData.choices[0].message.content = processedContent;
    }

    return new Response(JSON.stringify(jsonData), {
      status: response.status,
      headers: response.headers
    });
  }
  
  return response;
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    return new Response('Proxy is Running！', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }

  if (pathname.includes('api.groq.com')) {
    resetCountersIfNeeded();

    if (rateLimiter.requests >= 30) {
      return new Response('Rate limit exceeded. Max 30 requests per minute.', {
        status: 429,
        headers: {
          'Retry-After': '60',
          'Content-Type': 'application/json'
        }
      });
    }

    try {
      const bodyClone = request.clone();
      const body = await bodyClone.json();
      const estimatedTokens = estimateTokens(body);

      if (rateLimiter.tokens + estimatedTokens > 6000) {
        return new Response('Token limit exceeded. Max 6000 tokens per minute.', {
          status: 429,
          headers: {
            'Retry-After': '60',
            'Content-Type': 'application/json'
          }
        });
      }

      rateLimiter.tokens += estimatedTokens;
    } catch (error) {
      console.error('Error parsing request body:', error);
    }

    rateLimiter.requests++;
  }

  const targetUrl = `https://${pathname}`;

  try {
    const headers = new Headers();
    const allowedHeaders = ['accept', 'content-type', 'authorization'];
    for (const [key, value] of request.headers.entries()) {
      if (allowedHeaders.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.body
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Referrer-Policy', 'no-referrer');
    responseHeaders.set('X-RateLimit-Remaining', `${30 - rateLimiter.requests}`);
    responseHeaders.set('X-TokenLimit-Remaining', `${6000 - rateLimiter.tokens}`);

    const processedResponse = await processResponse(response);

    return new Response(processedResponse.body, {
      status: processedResponse.status,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('Failed to fetch:', error);
    return new Response(JSON.stringify({
      error: 'Internal Server Error',
      message: error.message
    }), { 
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}

Deno.serve(handleRequest);
