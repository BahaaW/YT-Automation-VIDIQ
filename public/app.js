document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const systemStateBadge = document.getElementById('systemStateBadge');
  const systemStateText = systemStateBadge.querySelector('.status-text');
  
  const ytStatusBadge = document.getElementById('ytStatusBadge');
  const tgStatusBadge = document.getElementById('tgStatusBadge');
  const btnConnectYoutube = document.getElementById('btnConnectYoutube');
  
  const configForm = document.getElementById('configForm');
  const tgTokenInput = document.getElementById('tgToken');
  const tgChatIdInput = document.getElementById('tgChatId');
  const scheduleTimeInput = document.getElementById('scheduleTime');
  
  const triggerForm = document.getElementById('triggerForm');
  const videoUrlInput = document.getElementById('videoUrl');
  const promptInput = document.getElementById('prompt');
  const btnTrigger = document.getElementById('btnTrigger');
  const btnTriggerText = btnTrigger.querySelector('.btn-text');
  const btnTriggerSpinner = btnTrigger.querySelector('.spinner');
  
  const historyList = document.getElementById('historyList');
  const consoleLogs = document.getElementById('consoleLogs');
  const btnClearLogs = document.getElementById('btnClearLogs');

  let currentLogsLength = 0;

  // Poll status initially and on interval
  fetchStatus();
  setInterval(fetchStatus, 4000);

  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('API request failed');
      const data = await res.json();
      
      updateSystemState(data.state);
      updateIntegrations(data.youtube_connected, data.telegram_connected);
      updateConfigFields(data.daily_schedule_time);
      updateHistory(data.history);
      updateLogs(data.logs);
      
    } catch (err) {
      console.error('Error fetching system status:', err);
      systemStateText.textContent = 'OFFLINE';
      systemStateBadge.className = 'system-badge busy';
    }
  }

  function updateSystemState(state) {
    if (state === 'idle') {
      systemStateText.textContent = 'SYSTEM IDLE';
      systemStateBadge.className = 'system-badge';
      
      btnTrigger.disabled = false;
      btnTriggerText.textContent = 'Execute Clipping Run';
      btnTriggerSpinner.classList.add('hidden');
    } else {
      systemStateText.textContent = `SYSTEM BUSY (${state.toUpperCase()})`;
      systemStateBadge.className = 'system-badge busy';
      
      btnTrigger.disabled = true;
      btnTriggerText.textContent = 'Processing Workflow...';
      btnTriggerSpinner.classList.remove('hidden');
    }
  }

  function updateIntegrations(ytConnected, tgConnected) {
    // YouTube
    if (ytConnected) {
      ytStatusBadge.textContent = 'Connected';
      ytStatusBadge.className = 'badge connected';
      btnConnectYoutube.textContent = 'YouTube Account Linked';
      btnConnectYoutube.disabled = true;
      btnConnectYoutube.className = 'btn btn-outline';
    } else {
      ytStatusBadge.textContent = 'Disconnected';
      ytStatusBadge.className = 'badge disconnected';
      btnConnectYoutube.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg> Link YouTube Channel`;
      btnConnectYoutube.disabled = false;
      btnConnectYoutube.className = 'btn btn-primary';
    }

    // Telegram
    if (tgConnected) {
      tgStatusBadge.textContent = 'Online';
      tgStatusBadge.className = 'badge connected';
    } else {
      tgStatusBadge.textContent = 'Setup Required';
      tgStatusBadge.className = 'badge disconnected';
    }
  }

  function updateConfigFields(scheduleTime) {
    // Only update if the user isn't currently editing/focusing the field
    if (document.activeElement !== scheduleTimeInput) {
      scheduleTimeInput.value = scheduleTime;
    }
  }

  function updateHistory(history) {
    if (!history || history.length === 0) {
      historyList.innerHTML = '<div class="empty-state">No jobs run yet. Set up configurations and trigger one!</div>';
      return;
    }

    let html = '';
    history.forEach(run => {
      const formattedDate = new Date(run.timestamp).toLocaleString();
      let statusClass = run.status;
      if (run.status === 'processing' || run.status === 'downloading') statusClass = 'processing';
      
      let clipsHtml = '';
      if (run.clips && run.clips.length > 0) {
        clipsHtml = '<div class="history-clips">';
        run.clips.forEach(clip => {
          let linkHtml = `<span class="help-text">Status: ${clip.status}</span>`;
          if (clip.status === 'completed' && clip.videoId) {
            linkHtml = `<a href="https://youtu.be/${clip.videoId}" target="_blank" class="clip-link">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              View on YouTube
            </a>`;
          }
          clipsHtml += `
            <div class="clip-entry">
              <span class="clip-title">${clip.title}</span>
              ${linkHtml}
            </div>
          `;
        });
        clipsHtml += '</div>';
      }

      html += `
        <div class="history-item">
          <div class="history-header">
            <span class="history-title">${run.url}</span>
            <span class="history-time">${formattedDate}</span>
          </div>
          <div class="history-prompt">Prompt: "${run.prompt}"</div>
          <div class="history-footer">
            <div class="run-status ${statusClass}">
              <span class="pulse-indicator"></span>
              ${run.status}
            </div>
            ${run.error ? `<span class="help-text" style="color: var(--danger)">Error: ${run.error}</span>` : ''}
          </div>
          ${clipsHtml}
        </div>
      `;
    });

    historyList.innerHTML = html;
  }

  function updateLogs(logs) {
    if (!logs) return;
    
    // Only update and scroll if the log length has changed
    if (logs.length !== currentLogsLength) {
      currentLogsLength = logs.length;
      consoleLogs.textContent = logs.join('\n');
      consoleLogs.scrollTop = consoleLogs.scrollHeight;
    }
  }

  // Event Listeners
  
  // Connect YouTube
  btnConnectYoutube.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/auth/youtube');
      if (!res.ok) throw new Error('Failed to get auth URL');
      const data = await res.json();
      
      // Open OAuth in new tab
      window.open(data.url, '_blank');
    } catch (err) {
      alert('Error connecting to YouTube: ' + err.message);
    }
  });

  // Save Config
  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const body = {};
    if (tgTokenInput.value.trim()) body.telegram_token = tgTokenInput.value.trim();
    if (tgChatIdInput.value.trim()) body.telegram_chat_id = tgChatIdInput.value.trim();
    if (scheduleTimeInput.value) body.daily_schedule_time = scheduleTimeInput.value;
    
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      if (!res.ok) throw new Error('Failed to save config');
      alert('Settings successfully saved! Bot initialized.');
      tgTokenInput.value = ''; // Clear password field
      fetchStatus();
    } catch (err) {
      alert('Error saving settings: ' + err.message);
    }
  });

  // Trigger Manual Job
  triggerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const url = videoUrlInput.value.trim();
    const prompt = promptInput.value.trim();
    
    if (!url) return;
    
    try {
      btnTrigger.disabled = true;
      btnTriggerText.textContent = 'Submitting job...';
      btnTriggerSpinner.classList.remove('hidden');
      
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, prompt })
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to trigger run');
      }
      
      videoUrlInput.value = '';
      promptInput.value = '';
      alert('Job successfully submitted to VidIQ! Check the history card for progress.');
      fetchStatus();
    } catch (err) {
      alert('Error triggering job: ' + err.message);
      btnTrigger.disabled = false;
      btnTriggerText.textContent = 'Execute Clipping Run';
      btnTriggerSpinner.classList.add('hidden');
    }
  });

  // Clear log display
  btnClearLogs.addEventListener('click', () => {
    consoleLogs.textContent = '';
    currentLogsLength = 0;
  });
});
