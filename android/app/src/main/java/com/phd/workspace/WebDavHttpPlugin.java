package com.phd.workspace;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

@CapacitorPlugin(name = "WebDavHttp")
public class WebDavHttpPlugin extends Plugin {
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void request(final PluginCall call) {
        executor.submit(() -> {
            try {
                call.resolve(execute(call));
            } catch (Exception error) {
                call.reject(error.getMessage(), error.getClass().getSimpleName(), error);
            }
        });
    }

    private JSObject execute(PluginCall call) throws IOException {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        JSObject headers = call.getObject("headers", new JSObject());
        String data = call.getString("data");
        Integer connectTimeout = call.getInt("connectTimeout", 20000);
        Integer readTimeout = call.getInt("readTimeout", 30000);

        OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(connectTimeout, TimeUnit.MILLISECONDS)
            .readTimeout(readTimeout, TimeUnit.MILLISECONDS)
            .build();

        Request.Builder request = new Request.Builder().url(url);
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String value = headers.getString(key);
            if (value != null) request.header(key, value);
        }

        RequestBody requestBody = null;
        if (data != null) {
            String contentType = headers.getString("Content-Type", headers.getString("content-type", "application/octet-stream"));
            requestBody = RequestBody.create(MediaType.parse(contentType), data);
        }
        if ("GET".equals(method) || "HEAD".equals(method)) {
            request.method(method, null);
        } else {
            request.method(method, requestBody);
        }

        try (Response response = client.newCall(request.build()).execute()) {
            ResponseBody responseBody = response.body();
            Headers responseHeaders = response.headers();
            String body = responseBody != null ? responseBody.string() : "";
            String etag = firstHeader(responseHeaders, "ETag");
            String lastModified = firstHeader(responseHeaders, "Last-Modified");
            Long size = parseLong(firstHeader(responseHeaders, "Content-Length"));
            if (size == null) size = (long) body.getBytes().length;
            JSObject result = new JSObject();
            result.put("status", response.code());
            result.put("url", response.request().url().toString());
            result.put("headers", toJSObject(responseHeaders));
            result.put("body", body);
            result.put("data", body);
            result.put("etag", etag != null ? etag : "");
            result.put("lastModified", lastModified != null ? lastModified : "");
            result.put("size", size);
            return result;
        }
    }

    private JSObject toJSObject(Headers headers) {
        JSObject result = new JSObject();
        for (String name : headers.names()) {
            result.put(name, joinHeaderValues(headers.values(name)));
        }
        return result;
    }

    private String joinHeaderValues(List<String> values) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) builder.append(", ");
            builder.append(values.get(i));
        }
        return builder.toString();
    }

    private String firstHeader(Headers headers, String key) {
        for (String name : headers.names()) {
            if (name.equalsIgnoreCase(key)) {
                return headers.get(name);
            }
        }
        return null;
    }

    private Long parseLong(String value) {
        if (value == null) return null;
        try {
            return Long.parseLong(value.trim());
        } catch (Exception ignored) {
            return null;
        }
    }
}
