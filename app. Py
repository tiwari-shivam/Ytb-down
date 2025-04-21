import json
import os
import re
import subprocess
import tempfile
import uuid
import threading
import queue
import time
import shutil

from flask import Flask, render_template, request, jsonify, send_file, Response
from werkzeug.utils import secure_filename

app = Flask(__name__)

# Dictionary to store active download tasks: task_id -> { process, temp_dir, file_path, status, error_message, progress_queue, start_time }
# This is in-memory and will be lost if the server restarts.
# For a persistent solution, use a database or dedicated task queue.
download_tasks = {}

# Ensure yt-dlp is available
try:
    result = subprocess.run(['yt-dlp', '--version'], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    app.logger.info(f"yt-dlp version: {result.stdout.strip()}")
except (subprocess.CalledProcessError, FileNotFoundError):
    app.logger.error("Error: yt-dlp not found or not executable. Please install it (`pip install yt-dlp` if using pip version, or ensure the binary is in your system's PATH).")
    # In a real app, you might set a flag here to indicate yt-dlp is missing and disable download features.

# Helper function to read stdout/stderr from subprocess non-blockingly
def enqueue_output(out, q):
    """Helper function to read lines from a stream and put them in a queue, signaling end."""
    try:
        for line in iter(out.readline, ''):
            q.put(line)
    except Exception as e:
        app.logger.error(f"Error reading process output stream: {e}")
    finally:
        # Signal end of stream with a marker
        q.put(None)


def cleanup_task(task_id):
    """Cleans up temporary files and directory for a given task."""
    task_info = download_tasks.get(task_id)
    if not task_info:
        app.logger.warning(f"Attempted cleanup for non-existent task_id: {task_id}")
        return

    temp_dir = task_info.get('temp_dir')
    app.logger.info(f"Attempting cleanup for task {task_id} in {temp_dir}")

    # Terminate the process if it's still running (should ideally be finished)
    process = task_info.get('process')
    if process and process.poll() is None:
        app.logger.warning(f"Terminating process for task {task_id} during cleanup.")
        try:
            process.terminate()
            process.wait(timeout=5) # Give it a few seconds to terminate
        except Exception as e:
            app.logger.error(f"Error terminating process for task {task_id}: {e}")

    if temp_dir and os.path.exists(temp_dir):
        try:
            # Use shutil.rmtree for recursive removal, ignore errors during cleanup
            shutil.rmtree(temp_dir, ignore_errors=True)
            app.logger.debug(f"Removed temp directory: {temp_dir}")
        except Exception as e:
            app.logger.error(f"Error removing temp directory {temp_dir} for task {task_id}: {e}")

    # Remove task from the in-memory dictionary
    if task_id in download_tasks:
        del download_tasks[task_id]
        app.logger.debug(f"Removed task {task_id} from memory.")


def get_formats(url):
    """Fetches available formats for a given URL using yt-dlp."""
    try:
        result = subprocess.run(
            ['yt-dlp', '-F', '--no-warnings', url],
            check=True,
            capture_output=True,
            text=True,
            encoding='utf-8'
        )
        output_lines = result.stdout.strip().split('\n')

        format_lines_start = -1
        for i, line in enumerate(output_lines):
            if re.match(r'^\s*ID\s+EXT\s+RESOLUTION', line, re.IGNORECASE) or \
               re.match(r'^\s*format code', line, re.IGNORECASE):
                format_lines_start = i + 1
                break

        formats = []
        # Regex to capture columns: ID, EXT, RESOLUTION/NOTE, FILESIZE/FPS, DESCRIPTION/NOTE
        format_line_pattern = re.compile(r'^\s*(\S+)\s+(\S+)\s+(\S+)?\s+(\S+)?\s*(.*?)$')

        for line in output_lines[format_lines_start:]:
             if line.strip() == '' or line.startswith('---'):
                 continue

             match = format_line_pattern.match(line)
             if match:
                format_id = match.group(1)
                ext = match.group(2)
                res_or_note = match.group(3) or ''
                size_or_fps = match.group(4) or ''
                description_part = match.group(5) or ''

                description = f"{res_or_note} {size_or_fps} {description_part}".strip()

                # Filter out potentially irrelevant formats (heuristic)
                if 'm3u8' in ext.lower() or 'dash' in ext.lower() or 'unknown' in ext.lower():
                     if not (ext in ['mp4', 'webm', 'mkv', 'aac', 'mp3', 'wav', 'opus', 'ogg'] or '[video only]' in description or '[audio only]' in description):
                         continue

                formats.append({
                     'format_id': format_id,
                     'ext': ext,
                     'description': description
                 })
             else:
                 app.logger.debug(f"Could not parse format line with regex, trying split: {line}")
                 parts = line.split(maxsplit=2)
                 if len(parts) >= 2:
                      formats.append({
                         'format_id': parts[0],
                         'ext': parts[1],
                         'description': parts[2] if len(parts) > 2 else 'N/A - ' + line
                     })
                 else:
                      app.logger.warning(f"Skipping unparseable format line: {line}")


        # Basic sorting attempt (based on heuristics)
        def sort_key(f):
            desc = f['description'].lower()
            res_match = re.search(r'(\d+p|\d+x\d+)', desc)
            if res_match:
                 res_str = res_match.group(1)
                 try:
                     if 'p' in res_str:
                        return int(res_str.replace('p', ''))
                     elif 'x' in res_str:
                        return int(res_str.split('x')[-1])
                     else:
                         return 0
                 except ValueError:
                     pass
            bitrate_match = re.search(r'(\d+(\.\d+)?(?:k|m))', desc)
            if bitrate_match:
                 try:
                     val = float(bitrate_match.group(1).replace('k','').replace('m',''))
                     if 'm' in bitrate_match.group(1).lower():
                         val *= 1000
                     return int(val)
                 except ValueError:
                     pass
            return 0

        try:
            formats.sort(key=sort_key, reverse=True)
        except Exception as e:
            app.logger.warning(f"Could not sort formats: {e}")
            pass

        return {'formats': formats}, 200

    except subprocess.CalledProcessError as e:
        app.logger.error(f"yt-dlp error: {e.stderr.decode('utf-8', errors='ignore')}")
        return {'error': f"yt-dlp error: {e.stderr.decode('utf-8', errors='ignore').strip()}"}, 500
    except Exception as e:
        app.logger.error(f"Server error: {e}")
        return {'error': f"Server error: {e}"}, 500

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/get_formats', methods=['POST'])
def api_get_formats():
    data = request.get_json()
    url = data.get('url')

    if not url:
        return jsonify({'error': 'URL is required'}), 400

    app.logger.info(f"Fetching formats for URL: {url}")
    formats, status_code = get_formats(url)
    return jsonify(formats), status_code

@app.route('/start_download', methods=['POST'])
def api_start_download():
    """Initiates a download task and returns a task ID."""
    data = request.get_json()
    url = data.get('url')
    format_id = data.get('format_id')

    if not url or not format_id:
        return jsonify({'error': 'URL and format_id are required'}), 400

    task_id = str(uuid.uuid4())
    temp_dir = None
    process = None

    try:
        temp_dir = tempfile.mkdtemp()
        app.logger.info(f"Initiating download task {task_id} for URL: {url} format: {format_id} to {temp_dir}")

        output_template = os.path.join(temp_dir, '%(title).50s.%(ext)s')

        command = ['yt-dlp', '-f', format_id, '--no-part', '--no-warnings', '-o', output_template, url]
        app.logger.debug(f"Running command: {' '.join(command)}")

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            bufsize=1
        )

        download_tasks[task_id] = {
            'process': process,
            'temp_dir': temp_dir,
            'file_path': None,
            'status': 'running',
            'error_message': None,
            'progress_queue': queue.Queue(),
            'start_time': time.time()
        }

        stdout_thread = threading.Thread(target=enqueue_output, args=(process.stdout, download_tasks[task_id]['progress_queue']))
        stderr_thread = threading.Thread(target=enqueue_output, args=(process.stderr, download_tasks[task_id]['progress_queue']))
        stdout_thread.daemon = True
        stderr_thread.daemon = True
        stdout_thread.start()
        stderr_thread.start()

        return jsonify({'task_id': task_id}), 202

    except Exception as e:
        app.logger.error(f"Error starting download task {task_id}: {e}", exc_info=True)
        if temp_dir and os.path.exists(temp_dir):
             try:
                 shutil.rmtree(temp_dir, ignore_errors=True)
                 app.logger.debug(f"Cleaned up temp dir {temp_dir} after start failure.")
             except Exception as ce:
                 app.logger.error(f"Error during cleanup after task start failure: {ce}")

        if task_id in download_tasks:
             del download_tasks[task_id]

        return jsonify({'error': f"Could not start download task: {e}"}), 500

@app.route('/progress/<task_id>')
def progress(task_id):
    """Streams download progress for a given task ID using Server-Sent Events (SSE)."""
    task_info = download_tasks.get(task_id)
    if not task_info:
        response_data = json.dumps({'status': 'error', 'message': 'Task not found or has expired.'})
        return Response(response_data,
                        mimetype='text/event-stream',
                        status=404,
                        headers={'Cache-Control': 'no-cache'})

    process = task_info['process']
    q = task_info['progress_queue']
    start_time = task_info.get('start_time', time.time())

    expected_threads = 2 # We have 2 threads feeding the queue (stdout, stderr)


    def generate():
        nonlocal task_info # Allow modifying task_info from outer scope
        finished_threads_count = 0

        if task_info['status'] != 'running':
             # If status is already set (e.g., failed immediately), send final message
             yield f"data: {json.dumps({'status': task_info['status'], 'message': task_info['error_message'] or 'Finished'})}\n\n"
             return


        # Use a try...except block for GeneratorExit and other unexpected errors
        try:
            # Loop while the process is still running OR while there are still items in the queue
            # (Queue might contain remaining output or None markers even after process exits)
            while process.poll() is None or finished_threads_count < expected_threads or not q.empty():
                try:
                    # Read line from the queue with a short timeout
                    # This allows the loop to periodically check process.poll() and finished_threads_count
                    # even when there's no output.
                    line = q.get(timeout=0.1) # Wait up to 100ms

                    if line is None:
                        # This signals the end of a thread's output stream
                        finished_threads_count += 1
                        app.logger.debug(f"[{task_id}] Received stream end signal. Finished: {finished_threads_count}/{expected_threads}")
                        continue # Continue reading from queue, might have more from the other thread

                    line = line.strip()
                    if not line: # Skip empty lines after stripping
                         continue

                    # app.logger.debug(f"[{task_id}] From queue: {line}") # Verbose log

                    # --- Parse the line ---
                    # Parse progress lines
                    if '[download]' in line:
                         match = re.search(
                             r'\[download\]\s+(\d+\.\d+)% .*?(?:of\s+~?([\d\.]+[KMGTP]?i?B))?' # Percent and optional Total Size
                             r'(?:\s+at\s+([\d\.]+[KMGTP]?i?B/s))?' # Optional Speed
                             r'(?:\s+ETA\s+([\d:]+))?', # Optional ETA
                             line
                         )
                         if match:
                             percent = float(match.group(1))
                             total_size = match.group(2) if match.group(2) else 'N/A'
                             speed = match.group(3) if match.group(3) else 'N/A'
                             eta = match.group(4) if match.group(4) else 'N/A'

                             # Calculate elapsed time
                             elapsed = time.strftime('%H:%M:%S', time.gmtime(time.time() - start_time))

                             progress_data = {
                                 'status': 'progress',
                                 'percent': percent,
                                 'total_size': total_size,
                                 'speed': speed,
                                 'eta': eta,
                                 'elapsed': elapsed
                             }
                             yield f"data: {json.dumps(progress_data)}\n\n"
                             continue

                    # Parse lines containing final file path (Destination or Merging)
                    if '[download] Destination:' in line or '[Merger] Merging into' in line:
                        try:
                            file_path_match = re.search(r'(?:Destination|Merging into):\s*(.+)$', line)
                            if file_path_match:
                                found_path = file_path_match.group(1).strip()
                                # Safety check: Ensure path is within our temporary directory
                                temp_dir = task_info.get('temp_dir')
                                if temp_dir and found_path.startswith(temp_dir):
                                    task_info['file_path'] = found_path
                                    app.logger.info(f"[{task_id}] Detected final file path: {found_path}")
                                    yield f"data: {json.dumps({'status': 'info', 'message': f'Destination detected'})}\n\n"
                                else:
                                     app.logger.warning(f"[{task_id}] Detected suspicious file path outside temp dir or temp dir missing: {found_path}")
                                     # Optionally, yield a warning message to the client
                                     # yield f"data: {json.dumps({'status': 'warning', 'message': f'Suspicious path detected: {found_path}'})}\n\n"

                        except Exception as path_e:
                            app.logger.error(f"[{task_id}] Error extracting final file path from line '{line}': {path_e}")
                        continue


                    # Parse generic info lines (Extracting, generic info)
                    if '[Extracting]' in line or line.startswith('[info]'):
                         yield f"data: {json.dumps({'status': 'info', 'message': line})}\n\n"
                         continue

                    # Optional: Capture warning/error lines from stderr as info/warning
                    # if '[warning]' in line.lower() or '[error]' in line.lower():
                    #      yield f"data: {json.dumps({'status': 'warning', 'message': line})}\n\n"
                    #      continue


                    # If a line wasn't parsed by specific rules, send it as generic info
                    # This can be chatty, enable/disable based on desired verbosity
                    # yield f"data: {json.dumps({'status': 'info', 'message': line})}\n\n"


                except queue.Empty:
                    # Queue is temporarily empty. The loop condition will handle waiting or exiting.
                    pass
                except Exception as e:
                    app.logger.error(f"[{task_id}] Unexpected error processing queue item: {e}", exc_info=True)
                    # Don't break, try to process more items if possible.
                    # Optionally send a warning message to the client.
                    # yield f"data: {json.dumps({'status': 'warning', 'message': f'Server processing output error: {e}'})}\n\n"


            # --- Loop exited: Process has finished AND all streams signaled end ---
            app.logger.info(f"[{task_id}] Process finished ({process.returncode}) and output streams closed ({finished_threads_count}/{expected_threads}). Finalizing task status.")

            # Determine final status based on process return code
            returncode = process.returncode
            task_info['status'] = 'completed' if returncode == 0 else 'failed'

            # If process failed, try to capture error message if not already parsed from queue
            if task_info['status'] == 'failed' and task_info.get('error_message') is None:
                # The enqueue_output threads read stderr, so relevant error lines should be in the queue.
                # As a fallback, you could try reading remaining stderr here, but it's prone to
                # 'closed file' errors if the thread closed it. Relying on queue content is safer.
                # A simple approach is to set a generic error message if none was parsed.
                task_info['error_message'] = f'Download process failed with exit code {returncode}. Check logs for details.'
                app.logger.error(f"[{task_id}] Task failed, no specific error message captured from queue. Status: {task_info['error_message']}")


            # Verify file_path is found if download was successful
            if task_info['status'] == 'completed':
                if not task_info.get('file_path') or not os.path.exists(task_info['file_path']):
                     app.logger.error(f"[{task_id}] Download process completed, but file was not found or path not detected correctly.")
                     task_info['status'] = 'failed'
                     task_info['error_message'] = task_info['error_message'] or "Downloaded file not found after completion."

                     # Final fallback search for file in temp dir (might be necessary if Destination line was missed or format merging happened late)
                     temp_dir = task_info.get('temp_dir')
                     if temp_dir and os.path.exists(temp_dir):
                          try:
                              # Find the newest file in the temp directory as a heuristic
                              found_files = [os.path.join(temp_dir, f) for f in os.listdir(temp_dir) if os.path.isfile(os.path.join(temp_dir, f))]
                              if found_files:
                                  file_path = max(found_files, key=os.path.getctime)
                                  # Check if this file looks like a likely candidate (e.g., non-empty)
                                  if os.path.getsize(file_path) > 0:
                                      task_info['file_path'] = file_path # Update path
                                      task_info['status'] = 'completed' # Revert status if file found
                                      app.logger.info(f"[{task_id}] Fallback file search successful: {file_path}.")
                                  else:
                                      app.logger.warning(f"[{task_id}] Fallback file {file_path} was empty.")
                              else:
                                 app.logger.error(f"[{task_id}] Final fallback file search found no files in {temp_dir}.")
                          except Exception as fb_search_e:
                              app.logger.error(f"[{task_id}] Error during final fallback file search: {fb_search_e}")


            # --- Yield final message based on determined status ---
            elapsed = time.strftime('%H:%M:%S', time.gmtime(time.time() - start_time))

            if task_info['status'] == 'completed':
                yield f"data: {json.dumps({'status': 'complete', 'message': 'Download process finished. File is ready.', 'elapsed': elapsed})}\n\n"
            else: # Status is 'failed'
                error_msg = task_info['error_message'] or 'An unknown error occurred during download.'
                app.logger.error(f"[{task_id}] Final status: Failed. Error: {error_msg}")
                yield f"data: {json.dumps({'status': 'error', 'message': error_msg})}\n\n"


        except GeneratorExit:
            # This exception is raised by Werkzeug/Flask when the client disconnects
            app.logger.info(f"[{task_id}] Client disconnected from progress stream (GeneratorExit).")
            # Attempt to terminate the subprocess if client leaves early
            if process and process.poll() is None:
                 app.logger.warning(f"[{task_id}] Terminating subprocess due to client disconnect.")
                 try:
                     process.terminate()
                     # Cleanup will be handled by serve_download (if hit) or a separate cleanup job.
                 except Exception as term_e:
                     app.logger.error(f"[{task_id}] Error terminating process on disconnect: {term_e}")

        except Exception as e:
             # Catch any other unexpected errors in the generator itself
             app.logger.error(f"[{task_id}] Unexpected error in progress generator: {e}", exc_info=True)
             try:
                 yield f"data: {json.dumps({'status': 'error', 'message': f'Unexpected server error during progress stream: {e}'})}\n\n"
             except Exception as yield_e:
                 app.logger.error(f"[{task_id}] Error yielding final error message after exception: {yield_e}")
             # The generator will likely terminate after this exception


    # Set headers for Server-Sent Events
    response = Response(generate(), mimetype='text/event-stream')
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['Connection'] = 'keep-alive'
    response.headers['X-Accel-Buffering'] = 'no' # Important for some proxies (Nginx)
    return response


@app.route('/serve_download/<task_id>')
def serve_download(task_id):
    """Serves the completed download file for a given task ID and cleans up."""
    task_info = download_tasks.get(task_id)

    if not task_info or task_info.get('status') != 'completed':
        status = task_info.get('status', 'unknown') if task_info else 'unknown'
        error_msg = task_info.get('error_message', 'Download is not completed or task not found.') if task_info else 'Task not found.'
        app.logger.warning(f"Serve request for task {task_id} which is not completed or not found. Status: {status}")
        if task_info and status == 'failed':
             cleanup_task(task_id)
        return jsonify({'error': f'Download not ready ({status}): {error_msg}'}), 409

    file_path = task_info.get('file_path')
    if not file_path or not os.path.exists(file_path):
         # This case should ideally be caught by the progress generator's finalization
         # but we keep this as a final safety check.
         error_msg = task_info.get('error_message', 'Downloaded file not found on server after completion.')
         app.logger.error(f"File path not found or file does not exist during serve for task {task_id}: {file_path}. Status: {task_info.get('status')}")
         cleanup_task(task_id)
         return jsonify({'error': error_msg}), 500


    app.logger.info(f"Serving file for task {task_id}: {file_path}")

    try:
        safe_filename = secure_filename(os.path.basename(file_path))

        response = send_file(file_path, as_attachment=True, download_name=safe_filename)

        @response.call_on_close
        def cleanup_on_close():
             # Give OS a moment to release file handle
             # time.sleep(0.1) # Usually not needed but can help in tricky envs
             cleanup_task(task_id)


        return response

    except FileNotFoundError:
         app.logger.error(f"File not found during send_file for task {task_id}: {file_path}", exc_info=True)
         cleanup_task(task_id)
         return jsonify({'error': 'Downloaded file not found on server during transfer.'}), 500
    except Exception as e:
        app.logger.error(f"Error serving file for task {task_id}: {e}", exc_info=True)
        cleanup_task(task_id)
        return jsonify({'error': f"Error serving the file: {e}"}), 500


if __name__ == '__main__':
    # Running with threaded=True is essential
    # Consider using a production WSGI server (Gunicorn, Waitress) for robustness
    # host='0.0.0.0' to access from other devices on local network (use with caution)
    app.run(debug=True, threaded=True)
