document.addEventListener('DOMContentLoaded', () => {
    const urlInput = document.getElementById('video-url');
    const getFormatsBtn = document.getElementById('get-formats-btn');
    const qualitySection = document.getElementById('quality-section');
    const formatSelect = document.getElementById('format-select');
    const startDownloadBtn = document.getElementById('start-download-btn'); // Changed ID
    const statusSection = document.getElementById('status-section');
    const themeToggle = document.getElementById('theme-toggle');
    const body = document.body;

    // New progress elements
    const progressSection = document.getElementById('progress-section');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const statusInfo = document.getElementById('status-info');

    let currentEventSource = null; // To keep track of the active SSE connection
    let currentTaskId = null; // To keep track of the current download task ID

    // Load theme preference from localStorage
    const currentTheme = localStorage.getItem('theme');
    if (currentTheme === 'dark-mode') {
        body.classList.add('dark-mode');
        themeToggle.checked = true;
    } else {
        body.classList.remove('dark-mode');
        themeToggle.checked = false;
    }

    // Theme toggle listener
    themeToggle.addEventListener('change', () => {
        if (themeToggle.checked) {
            body.classList.add('dark-mode');
            localStorage.setItem('theme', 'dark-mode');
        } else {
            body.classList.remove('dark-mode');
            localStorage.setItem('theme', 'light-mode');
        }
    });

    // Function to display general status messages
    function setStatus(message, isError = false) {
        statusSection.textContent = message;
        if (isError) {
            statusSection.classList.add('error');
        } else {
            statusSection.classList.remove('error');
        }
    }

    // Function to update download progress display
    function updateProgress(percent, speed, eta, elapsed) {
        progressBar.style.width = `${percent}%`;
        // Optional: Display percentage text inside the bar if it's wide enough
        // progressBar.textContent = `${percent.toFixed(1)}%`;

        progressText.textContent = `Downloading: ${percent.toFixed(1)}%`;
        let details = [];
        if (speed && speed !== 'N/A') details.push(`Speed: ${speed}`);
        if (eta && eta !== 'N/A') details.push(`ETA: ${eta}`);
        if (elapsed) details.push(`Elapsed: ${elapsed}`);

        if (details.length > 0) {
            progressText.textContent += ` | ${details.join(' | ')}`;
        }
    }

     // Function to update download info messages
    function setStatusInfo(message) {
        statusInfo.textContent = message;
    }


    // Function to reset UI elements
    function resetUI() {
        qualitySection.classList.add('hidden');
        formatSelect.innerHTML = ''; // Clear previous options
        startDownloadBtn.disabled = true;
        setStatus(''); // Clear general status

        // Reset progress elements
        progressSection.classList.add('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = 'Waiting to start...';
        // progressBar.textContent = ''; // Clear text inside bar too
        setStatusInfo('');

        // Close any active SSE connection
        if (currentEventSource) {
            currentEventSource.close();
            currentEventSource = null;
            currentTaskId = null;
             console.log('SSE connection closed by resetUI');
        }
    }

    // Get Formats Button Click Listener
    getFormatsBtn.addEventListener('click', async () => {
        resetUI(); // Reset UI before fetching new formats
        const url = urlInput.value.trim();

        if (!url) {
            setStatus('Please enter a video URL.', true);
            return;
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
             setStatus('Please enter a valid URL starting with http:// or https://', true);
             return;
        }

        setStatus('Fetching available qualities...');
        getFormatsBtn.disabled = true; // Disable button while fetching

        try {
            const response = await fetch('/get_formats', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: url }),
            });

            const data = await response.json();

            if (response.ok) {
                if (data.formats && data.formats.length > 0) {
                    // Sort options visually (already sorted backend, but double check)
                     data.formats.sort((a, b) => {
                        // Simple resolution/filesize heuristic for client-side sort fallback
                        const a_desc = a.description.toLowerCase();
                        const b_desc = b.description.toLowerCase();
                        const res_a = parseInt((a_desc.match(/\d+p/) || ['0'])[0].replace('p','')) || 0;
                        const res_b = parseInt((b_desc.match(/\d+p/) || ['0'])[0].replace('p','')) || 0;

                        if (res_b !== res_a) return res_b - res_a; // Sort by resolution first

                         // Fallback to alphabetical if resolution is same or missing
                         if (a_desc < b_desc) return -1;
                         if (a_desc > b_desc) return 1;
                         return 0;
                     });


                    data.formats.forEach(format => {
                        const option = document.createElement('option');
                        option.value = format.format_id;
                        // Display description, and format ID in parentheses
                        option.textContent = `${format.description} (ID: ${format.format_id})`;
                        formatSelect.appendChild(option);
                    });
                    qualitySection.classList.remove('hidden');
                    startDownloadBtn.disabled = false;
                    setStatus(`Found ${data.formats.length} qualities. Select one to download.`);
                } else {
                    setStatus('No downloadable formats found for this URL.', true);
                }
            } else {
                setStatus(`Error fetching formats: ${data.error || 'Unknown error'}`, true);
            }
        } catch (error) {
            console.error('Fetch error:', error);
            setStatus(`An error occurred: ${error.message}`, true);
        } finally {
             getFormatsBtn.disabled = false; // Re-enable button
        }
    });

    // Start Download Button Click Listener
    startDownloadBtn.addEventListener('click', async () => {
        const url = urlInput.value.trim();
        const formatId = formatSelect.value; // Get selected format ID

        if (!url || !formatId) {
            setStatus('URL or quality not selected.', true);
            return;
        }

        setStatus('Starting download task...');
        // Disable buttons during download
        getFormatsBtn.disabled = true;
        startDownloadBtn.disabled = true;
        qualitySection.classList.add('hidden'); // Hide quality selection

        // Reset progress display and show it
        progressSection.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = 'Initializing...';
        // progressBar.textContent = '';
        setStatusInfo('');
        setStatus(''); // Clear general status

        try {
            // Step 1: Request the backend to start the download process
            const startResponse = await fetch('/start_download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: url, format_id: formatId }),
            });

            const startData = await startResponse.json();

            if (startResponse.ok) {
                currentTaskId = startData.task_id;
                setStatus(`Download task started. Waiting for progress stream...`);
                progressText.textContent = 'Connecting...'; // Update progress text state

                // Step 2: Connect to the Server-Sent Events stream for progress
                // Close previous connection if it exists (shouldn't happen with resetUI, but safety)
                if (currentEventSource) {
                     currentEventSource.close();
                     console.log('Closed previous SSE connection before opening new one.');
                }
                currentEventSource = new EventSource('/progress/' + currentTaskId);

                currentEventSource.onopen = function(event) {
                     console.log('SSE connection opened.');
                     setStatus(`Connected to progress stream for task ${currentTaskId}`);
                     progressText.textContent = 'Waiting for initial data...';
                };


                currentEventSource.onmessage = function(event) {
                    let data;
                    try {
                         data = JSON.parse(event.data);
                    } catch (e) {
                         console.error('Failed to parse SSE data:', e, event.data);
                         setStatusInfo(`Failed to parse progress data: ${event.data}`);
                         return; // Skip processing if JSON is invalid
                    }

                    // console.log('SSE message:', data); // Log all messages

                    if (data.status === 'progress') {
                        updateProgress(data.percent, data.speed, data.eta, data.elapsed);
                        setStatus(''); // Clear general status on progress update
                    } else if (data.status === 'info') {
                         // Display general info messages from yt-dlp
                         setStatusInfo(data.message);
                         setStatus(''); // Clear general status on info update
                    }
                    else if (data.status === 'complete') {
                        updateProgress(100, 'N/A', '00:00', data.elapsed || 'N/A'); // Set progress to 100%
                        setStatusInfo(''); // Clear info message
                        setStatus('Download complete! Preparing file for your browser...');

                        // Step 3: Download the actual file from the serve endpoint
                        // This redirects the browser to the download URL
                        // The backend's send_file with as_attachment=True will handle the download prompt.
                        window.location.href = `/serve_download/${currentTaskId}`;

                        progressText.textContent = 'Download ready!'; // Update text after initiating file transfer

                        // Close the SSE connection as the task is done
                        if (currentEventSource) {
                            currentEventSource.close();
                            currentEventSource = null;
                             console.log('SSE connection closed on completion.');
                        }
                         // Re-enable buttons after download is effectively handled by browser
                        getFormatsBtn.disabled = false;
                        // startDownloadBtn is not re-enabled until new formats are fetched
                        startDownloadBtn.disabled = true;
                         // Hide progress section eventually? Maybe after a delay.
                         // progressSection.classList.add('hidden');


                    } else if (data.status === 'error') {
                        // Display error message
                        setStatusInfo(''); // Clear info message
                        setStatus(`Download failed: ${data.message}`, true);
                        progressText.textContent = 'Download failed.';
                        progressBar.style.backgroundColor = 'var(--error-color)'; // Red bar on error

                        // Close the SSE connection on error
                         if (currentEventSource) {
                            currentEventSource.close();
                            currentEventSource = null;
                            console.log('SSE connection closed on error.');
                        }
                         // Re-enable buttons
                        getFormatsBtn.disabled = false;
                        // startDownloadBtn.disabled = false; // Allow retrying maybe? Or hide section?
                        // Hide progress section on error, allow user to try getting formats again
                        progressSection.classList.add('hidden');


                    } else {
                         // Handle unexpected status messages
                         console.warn('Received unknown SSE status:', data.status, data);
                         setStatusInfo(`Received unknown status: ${data.status}`);
                    }
                };

                currentEventSource.onerror = function(event) {
                    console.error('SSE error:', event);
                    setStatusInfo(''); // Clear info message

                    // Handle different error types if needed
                    // event.eventPhase === EventSource.CLOSED indicates connection was closed
                    if (event.eventPhase === EventSource.CLOSED) {
                       setStatus('Progress connection closed by server or browser.', true);
                    } else {
                       setStatus('Error in progress stream. Download might have failed or connection lost.', true);
                    }
                    progressText.textContent = 'Connection error.';
                    progressBar.style.backgroundColor = 'var(--error-color)'; // Red bar on error


                    // Attempt to close the connection cleanly if it's still open
                    if (currentEventSource && currentEventSource.readyState !== EventSource.CLOSED) {
                       currentEventSource.close();
                       console.log('Attempted to close SSE connection on error.');
                    }
                    currentEventSource = null; // Clear reference

                    // Re-enable buttons (user might try again)
                    getFormatsBtn.disabled = false;
                    startDownloadBtn.disabled = false; // Allow user to click again?
                    progressSection.classList.add('hidden'); // Hide progress section on error

                };


            } else {
                // Error starting the task itself (e.g., invalid URL format caught by Flask, yt-dlp not found)
                setStatus(`Error starting task: ${startData.error || startResponse.statusText}`, true);
                 // Re-enable buttons if task didn't even start
                 getFormatsBtn.disabled = false;
                 startDownloadBtn.disabled = false;
                 progressSection.classList.add('hidden'); // Hide progress section on start error
            }

        } catch (error) {
            console.error('Start download fetch error:', error);
            setStatus(`An error occurred when requesting download start: ${error.message}`, true);
             // Re-enable buttons on critical failure
             getFormatsBtn.disabled = false;
             startDownloadBtn.disabled = false;
             progressSection.classList.add('hidden'); // Hide progress section on critical error
        }
    });
});

