# Năng lực phục vụ và xử lý đồng thời

> Bản dịch tiếng Việt của [CAPACITY.md](CAPACITY.md). Các con số và bảng biểu giữ
> nguyên như bản gốc; thuật ngữ kỹ thuật và mã lệnh được giữ bằng tiếng Anh.

Đường ống thoại thực sự chịu được bao nhiêu tải. Đo ngày 2026-10-20 trên các dịch
vụ đang chạy của máy phát triển — không phải mô hình hoá, không phải suy ra từ
thông số của nhà cung cấp.

Ba dịch vụ quyết định câu trả lời, và cả ba đều được đo ở mức đồng thời tăng dần:

| dịch vụ | endpoint | phần chạy phía sau |
|---|---|---|
| STT | `http://127.0.0.1:8080` | audio.cpp, backend CUDA, `model=stt` |
| TTS | `http://127.0.0.1:8082` | Audio Gateway, piper, giọng `bryce` |
| LLM | `http://127.0.0.1:11434` | `deepseek-v4.1-flash:cloud` qua daemon Ollama cục bộ |

Các phép đo không chạm vào dữ liệu ứng viên. Đầu vào STT là giọng nói do chính
dịch vụ TTS tổng hợp (một câu cố định lặp lại đến 58 giây); LLM nhận một lịch sử
tổng hợp gồm 20 tin nhắn.

---

## Năng lực đo được

### STT — audio.cpp

58,1 giây WAV mono 16 kHz, `language=en`:

| số yêu cầu đồng thời | tổng thời gian | độ trễ mỗi yêu cầu |
|---|---|---|
| 1 | 6,35 s | 6,35 s |
| 2 | 12,77 s | 6,38; 12,77 |
| 4 | 25,75 s | 6,44; 12,87; 19,32; 25,75 |

**~9,1x thời gian thực, xử lý tuần tự.** Thông lượng đứng yên ở 9,0-9,2x trong
khi độ trễ tăng tuyến tính: các yêu cầu xếp hàng sau nhau. Gửi thêm yêu cầu không
mua được thêm song song.

Một câu trả lời dài 90 giây tốn khoảng 10 giây thời gian phục vụ. Năm người cùng
bấm dừng trong vài giây sẽ đẩy người thứ năm vào khoảng 40 giây hàng đợi.

### TTS — Audio Gateway (piper)

Một câu dài 8,5 giây (33 từ):

| số yêu cầu đồng thời | tổng thời gian | độ trễ mỗi yêu cầu |
|---|---|---|
| 1 | 0,37 s | 366 ms |
| 2 | 0,71 s | 361; 710 |
| 4 | 1,41 s | 364; 713; 1075; 1410 |
| 8 | 2,76 s | 366 ... 2761 |

**~23,3x thời gian thực, cũng tuần tự.** Tính theo mỗi lượt thì chi phí nhỏ —
khoảng 18 chunk chỉ chiếm 3 giây thời gian phục vụ — nhưng API không giới hạn
fan-out, nên mỗi lần kết thúc một câu trong phản hồi sẽ giải phóng toàn bộ chunk
đang chờ cùng lúc.

### LLM — mô hình cloud qua Ollama

Prompt 1.053 token (prefix cache báo đã dùng lại 1.024 token), 100 token đầu ra,
`stream: true`:

| đồng thời | thành công | token nói đầu tiên | tổng thời gian stream |
|---|---|---|---|
| 1 | 1/1 | 0,92 s | 1,18 s |
| 2 | 2/2 | 0,95; 1,73 | <= 1,90 s |
| 4 | 4/4 | <= 2,15 s | <= 2,31 s |
| 8 | 8/8 | <= 3,63 s | <= 3,81 s |
| 16 | **15/16** | trung vị 2,99; lớn nhất 5,58 | trung vị 3,13 |
| 32 | **13/32** | trung vị 3,99; lớn nhất 6,23 | trung vị 4,14 |

Giới hạn này đến từ thoả thuận dịch vụ, không phải từ năng lực tính toán. Vượt
khoảng 15 yêu cầu đang xử lý, tài khoản trả về ngay:

```json
{"error": "too many concurrent requests"}
```

HTTP 429, không xếp hàng. Cả hai lần chạy 16 và 32 đều có từ 13 đến 15 yêu cầu
đang xử lý thành công, nên trần nằm ở khoảng 15 cho mỗi tài khoản.

Hai chi tiết khác từ cùng phép đo:

- Khoảng hai phần ba số chunk ở mức đồng thời 1 là `thinking` chứ không phải nội
  dung. Mô hình suy luận trước khi nói, và token *nói* đầu tiên vẫn dưới một giây.
- Prefix caching có tác dụng: phần system prompt lặp lại cộng với tiền tố lịch sử
  dùng chung được phục vụ từ cache qua các lần chạy.

### Một lượt voice-agent, từ đầu đến cuối

Được đo qua chính route thật — `POST /api/voice-agent/stream` — chứ không phải chỉ
các dịch vụ bên dưới. Route này không cần session: lịch sử nằm trong body của yêu
cầu và âm thanh trả về trực tiếp dưới dạng base64, nên phép đo không chạm cơ sở
dữ liệu và không ghi file nào.

Một câu trả lời dài 14,1 giây, lịch sử 19 tin nhắn, `language=english`,
`engine=piper`. Trung vị của ba lần chạy:

| biến thể | `text` đầu tiên | tổng thời gian lượt | âm thanh tạo ra |
|---|---|---|---|
| đầu vào văn bản, tắt tiếng | 0,99 s | 1,23 s | — |
| đầu vào văn bản, có đọc | 0,91 s | 1,38 s | 12,2 s |
| đầu vào âm thanh, tắt tiếng | 2,46 s | 2,63 s | — |
| đầu vào âm thanh, có đọc | 2,03 s | 2,71 s | 14,4 s |

Đọc như chi phí từng tầng trên đường tới hạn:

```
LLM (sinh đến chunk nói đầu tiên)      ~1,0 s
STT (câu trả lời 14,1 giây, 9,1x)      ~1,1-1,5 s
TTS (toàn bộ phản hồi, 23,3x)          ~0,1-0,2 s
```

TTS tạo ra 14 giây giọng nói nhưng chỉ cộng khoảng một phần mười giây vào lượt,
vì nó chạy phía sau luồng LLM và xong từ lâu trước khi phản hồi kết thúc. Route có
`await` từng câu trước khi đọc token tiếp theo, nhưng tổng hợp nhanh đến mức thời
gian chờ chỉ là vài mili giây — nó **không** buộc độ dài lượt vào tốc độ phát lại.

Ở các mức đồng thời:

| số lượt đồng thời | thành công | `text` đầu tiên (nhỏ nhất / trung vị / lớn nhất) | tổng lượt (nhỏ nhất / trung vị / lớn nhất) |
|---|---|---|---|
| 1 | 1/1 | 2,97 / 2,97 / 2,97 | 3,58 / 3,58 / 3,58 |
| 2 | 2/2 | 2,18 / 3,27 / 3,27 | 2,85 / 3,71 / 3,71 |
| 4 | 4/4 | 2,07 / 4,96 / 5,28 | 2,57 / 5,35 / 6,10 |
| 8 | 8/8 | 2,26 / 6,43 / 9,72 | 2,77 / 7,19 / 10,26 |

Cả tám lượt đều hoàn tất; trần ~15 yêu cầu của LLM chưa bị chạm tới. Độ phân tán
đến từ hàng đợi STT: tám câu trả lời đến cùng lúc, mỗi câu tốn ~1,55 giây thời
gian phục vụ, đẩy lượt cuối chậm khoảng 10 giây — đúng như `text` đầu tiên của nó
cho thấy. Chi phí riêng của API nhỏ: lượt nhanh nhất trong mỗi lô bắt đầu trong
vòng vài trăm mili giây so với số đo một lượt.

Đẩy vượt trần, không có lượt nào thất bại:

| số lượt đồng thời | hoàn tất | tổng thời gian | `text` đầu tiên (nhỏ nhất-lớn nhất) |
|---|---|---|---|
| 16 | 16/16 | 18,8 s | 2,57-18,48 s |
| 24 | 24/24 | 28,0 s | 2,20-27,34 s |

**Tính tuần tự của STT đang che khuất giới hạn đồng thời của LLM.** Phép đo LLM
trực tiếp chạm `429` ở mức 16; route ở mức 16 và 24 không sinh ra lỗi nào vì các
lượt đến mô hình lần lượt, mỗi khi phiên âm xong và giải phóng, nên không bao giờ
có hơn ~15 lượt đang xử lý cùng lúc. Cái giá rơi vào phần đuôi: với 24 câu trả lời
cùng lúc, người cuối cùng chờ 27 giây mới nghe được từ đầu tiên.

Sự tương tác này quan trọng với các đòn bẩy bên dưới. Làm STT song song (đòn bẩy
1 hoặc 2) vừa bỏ được hàng đợi, vừa bỏ luôn cái van hãm tình cờ; khi đó, nếu không
có hàng đợi hoặc retry trước mô hình, cùng một đợt bùng nổ sẽ bắt đầu làm lượt
*thất bại* thay vì chỉ làm chậm chúng. Hai việc nên đi cùng nhau.

---

## Một khối lượng công việc tốn bao nhiêu

Các giả định, nêu ra để có thể sửa: một chu kỳ lượt khoảng 2,5 phút (1,5 phút nói,
~1 phút nghe và đọc phản hồi), nên một người ở trạng thái giữa lượt khoảng 60% thời
gian; ~18 chunk TTS mỗi phản hồi; câu trả lời 1,5 phút tải lên ở 32 kB/s (~2,9 MB).

Do đó 100 cuộc phỏng vấn đồng thời tạo ra khoảng **0,7 lượt/giây**, tức 2.400
lượt/giờ.

| tài nguyên | nhu cầu | năng lực đo được | số tiến trình cần |
|---|---|---|---|
| âm thanh STT | ~63 giây âm thanh mỗi giây | 9,1x mỗi tiến trình | **7-8** |
| giọng nói TTS | ~50 giây giọng nói mỗi giây | 23,3x mỗi tiến trình | **2-3** (nhiều hơn khi bùng nổ) |
| luồng LLM | ~4 đồng thời trung bình | ~15 đồng thời trước khi 429 | 1 tài khoản, còn dư |
| bản ghi trên đĩa | ~7,2 GB/giờ | — | chính sách lưu trữ, không phải năng lực |

Đọc bảng theo đúng thứ tự đó. STT là ràng buộc quyết định, cách xa phần còn lại;
TTS đứng sau; LLM cloud thoải mái ở mức trung bình và vỡ khi bùng nổ.

### Ở năm cuộc phỏng vấn đồng thời

Mọi thứ đều chịu được, trừ STT. Năm lượt trùng nhau đẩy ~50 giây âm thanh qua một
dịch vụ tuần tự 9x, và người cuối cùng ngồi im với một vòng xoay chờ. TTS xử lý
một đợt năm lượt trong ~16 giây thời gian phục vụ, và LLM cùng lắm thấy năm luồng
đồng thời.

### Ở 100 cuộc phỏng vấn đồng thời

- **STT** cần một pool 7-8 tiến trình, hoặc chuyển sang thứ gì đó xử lý theo lô.
  Việc một GPU có chứa nổi ngần ấy instance audio.cpp hay không thì chưa đo.
- **TTS** cần 2-3 worker gateway, và nên giới hạn fan-out mỗi lượt trước, để pool
  nhận được một hàng đợi thay vì một cú tăng vọt.
- **LLM** ổn ở mức trung bình và vỡ khi bùng nổ: không có retry, một đợt vượt ~15
  sẽ biến thành các lượt thất bại thay vì các lượt chậm.
- **Đĩa** tăng ~7,2 GB/giờ bản ghi, trước khi tính bất kỳ chính sách lưu trữ nào.
- **Tiến trình API hiện không thể nhân bản.** Prefetch holds, tool-call waits và
  MCP transports đều là map trong tiến trình, nên instance thứ hai sẽ cần sticky
  session hoặc đưa trạng thái ra ngoài.

---

## Các phát hiện từ những phép đo

1. **`config.ollama.retries` là cấu hình chết.** Nó được khai báo trong cả
   `src/lib/config/production.ts` và `development.ts` nhưng không được đọc ở đâu
   trong `src/`. Không có đường gọi nào retry, và các route streaming cũng không
   tự retry, nên một lỗi 429 làm lượt thất bại ngay lần đầu.
2. **Giọng piper mặc định trong cấu hình không có ở gateway.** Mặc định là
   `en_US-lessac-medium`; gateway chỉ có `bryce`, `en_US-norman-medium`,
   `fr_FR-tom-medium`, `vi_VN-vais1000-medium`. File `.env` đang chạy đặt
   `PIPER_VOICE_ENGLISH=bryce`, nên lượt vẫn chạy — nhưng một triển khai không có
   override đó sẽ trả 502 cho mọi lượt piper tiếng Anh.
3. **File tải lên được giữ nguyên trong bộ nhớ.** `multer.memoryStorage()` không
   đặt `limits` (`src/routes/voice.ts`, `src/routes/voice-agent.ts`), dù file được
   ghi xuống đĩa ngay sau đó. Với 100 lượt đang xử lý, đó là hàng chục đến hàng
   trăm megabyte RSS tạm thời.
4. **Fan-out TTS mỗi lượt là không giới hạn.** Cả hai route streaming đều lên lịch
   tổng hợp cho từng chunk và không bao giờ chặn số việc đang chạy.
   `/api/voice/stream` không rút cạn luồng LLM; `/api/voice-agent/stream` thì có.
   Đo từ đầu đến cuối, lựa chọn thứ hai tốn khoảng một phần mười giây mỗi lượt —
   `await` nằm ở bước tổng hợp, không phải phát lại — nên rủi ro là fan-out, không
   phải backpressure. Hai route vẫn giữ hai chính sách trái ngược mà không có lý do
   nào được nêu.
5. **`/api/voice/stream` quét lại toàn bộ phản hồi sau mỗi token**
   (`stripMarkdown`, `hasUnclosedCodeFence`, `splitSentences` trên toàn bộ văn bản
   tích luỹ), trong khi `/api/voice-agent/stream` dùng bộ trích xuất tăng dần. Một
   trong hai là bậc hai theo độ dài phản hồi, ngay trên event loop.

---

## Các đòn bẩy, theo thứ tự hiệu quả

1. **Đưa STT ra khỏi đường tới hạn.** Phiên âm theo từng cửa sổ trong lúc câu trả
   lời còn đang được ghi, thay vì phiên âm cả file sau khi dừng. Đây là thay đổi
   duy nhất cải thiện cả mức năm lẫn mức 100. Nó dùng chung đường ống ghi âm với
   thay đổi phía client đang cắt âm thanh thành cửa sổ để ghép.
2. **Mở rộng các dịch vụ âm thanh.** 7-8 tiến trình STT và 2-3 tiến trình TTS ở
   mức 100; chính thay đổi này cũng làm mức năm hết xếp hàng. Kiểm tra trước xem
   mỗi dịch vụ có thể xử lý theo lô nội bộ thay vì chạy N bản sao hay không.
3. **Retry 429 với jitter và giới hạn số yêu cầu LLM đang xử lý ở ~12.** Nhỏ và cơ
   học; biến chế độ thất bại cứng thành một khoảng chờ.
4. **Giới hạn TTS mỗi lượt và thống nhất chính sách backpressure của hai route.**
5. **Tải file trực tiếp xuống đĩa thay vì vào bộ nhớ**, và quyết định chính sách
   lưu trữ bản ghi.

---

## Hạn chế của phép đo

- Mỗi ô là một lần chạy, trừ trung vị ở mức đồng thời 16 và 32. Độ biến thiên chưa
  được đặc trưng hoá.
- Máy này chạy toàn bộ stack (API, client, doc-etl, tầng âm thanh, daemon Ollama)
  trên một máy; các dịch vụ âm thanh rảnh ngoài lúc đo.
- Đầu vào STT là giọng nói tổng hợp, lặp lại cho đủ dài. Giọng nói tự nhiên, đặc
  biệt tiếng Việt, có thể khác — tiếng Việt còn tốn khoảng 2,8x token mỗi ký tự,
  làm prompt và phản hồi dài hơn, do đó dịch chuyển cả số của LLM lẫn TTS.
- Gateway chỉ được đo với piper. Kokoro và supertonic chạy mô hình khác và chưa
  được đo.
- Phép đo từ đầu đến cuối dừng ở 24 lượt đồng thời, và phản hồi được giữ ngắn (2-3
  câu) bởi system prompt. Một phản hồi dài tốn thời gian TTS tỉ lệ thuận — ở
  23,3x thời gian thực, phản hồi nói 60 giây tốn ~2,6 giây thời gian phục vụ thay
  vì ~0,1 giây.
- Trần 429 là ở cấp tài khoản và có thể thay đổi theo điều khoản của nhà cung cấp.

## Cách tái lập

```bash
# health
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8082/health
curl -s http://127.0.0.1:11434/api/ps

# STT: WAV mono 16 kHz, multipart
curl -s -X POST http://127.0.0.1:8080/v1/audio/transcriptions \
  -F "file=@answer.wav;type=audio/wav" -F model=stt -F language=en

# TTS
curl -s -X POST http://127.0.0.1:8082/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"text":"...","engine":"piper","voice":"bryce"}' -o out.wav

# LLM stream (đo thời gian đến chunk nội dung đầu tiên, không phải byte đầu tiên)
curl -s -N http://127.0.0.1:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash:cloud","stream":true,"messages":[...],
       "options":{"num_predict":100}}'
```

Điểm mấu chốt là tính đồng thời: chạy mỗi phép đo ở N = 1, 2, 4, 8, 16, 32 và ghi
lại cả độ trễ từng yêu cầu lẫn thông lượng tổng. Một đường thông lượng phẳng cùng
với độ trễ tăng tuyến tính nghĩa là dịch vụ đang xử lý tuần tự.
