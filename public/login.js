const form = document.querySelector('#loginForm');
const error = document.querySelector('#error');
const submitButton = document.querySelector('.submit');
const password = document.querySelector('#password');
const toggle = document.querySelector('#toggle');

const setError = (message = '') => {
  error.textContent = message;
  error.hidden = !message;
};

toggle.addEventListener('click', () => {
  const showing = password.type === 'text';
  password.type = showing ? 'password' : 'text';
  toggle.textContent = showing ? 'Hiện' : 'Ẩn';
  toggle.setAttribute('aria-label', showing ? 'Hiện mật khẩu' : 'Ẩn mật khẩu');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  setError();
  submitButton.disabled = true;
  submitButton.classList.add('loading');
  try {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Không thể đăng nhập lúc này');
    window.location.href = data.redirect || '/';
  } catch (err) {
    setError(err.message);
    submitButton.disabled = false;
    submitButton.classList.remove('loading');
  }
});
