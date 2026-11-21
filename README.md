# Virgin Radio Discord Botu

Sadece **Virgin Radio Türkiye** çalan basit bir Discord radyo botu.

## Komutlar

| Komut | Ne yapar? |
| --- | --- |
| `/radyo` | Bulunduğun ses kanalına girer ve Virgin Radio'yu başlatır |
| `/dur` | Radyoyu durdurur ve kanaldan çıkar |
| `/ses seviye:50` | Ses seviyesini ayarlar (1–100) |

Yayın koparsa bot otomatik olarak yeniden bağlanır; bir yayın adresi çalışmazsa yedek adrese geçer.

## Kurulum

### 1. Node.js
**Node.js 22.12 veya üstü** gerekir (https://nodejs.org → LTS sürümü). Kontrol: `node -v`

### 2. Botu Discord'da oluştur
1. https://discord.com/developers/applications → **New Application**
2. Soldan **Bot** → **Reset Token** → tokeni kopyala (kimseyle paylaşma!)
3. Özel "Privileged Intent" açmana gerek yok.
4. Soldan **OAuth2 → URL Generator**:
   - Scopes: `bot` ve `applications.commands`
   - Bot Permissions: `View Channels`, `Connect`, `Speak`
5. Oluşan linki tarayıcıda aç ve botu sunucuna ekle.

### 3. Projeyi hazırla
Bu klasörde terminal açıp:

```bash
npm install
```

`.env.example` dosyasını `.env` adıyla kopyala ve `DISCORD_TOKEN` satırına tokenini yapıştır.

### 4. Çalıştır
```bash
npm start
```

Konsolda `... olarak giriş yapıldı` ve `Komutlar hazır` yazısını görünce Discord'da bir ses kanalına girip `/radyo` yaz.

## 7/24 çalışsın istiyorum
`.env` içindeki `AUTO_JOIN_CHANNEL_ID` alanına ses kanalının ID'sini yaz. Bot her açıldığında o kanala girip radyoyu başlatır. 7/24 için botu bir VPS'te ya da bilgisayarın hep açık kaldığı bir yerde çalıştırman gerekir (`pm2 start index.js --name virgin-radio` işini kolaylaştırır).

## Sorun giderme
- **Komutlar görünmüyor:** Botu davet ederken `applications.commands` kapsamını seçtiğinden emin ol, botu sunucudan atıp linkle yeniden ekle.
- **Ses gelmiyor:** Botun kanalda `Connect` ve `Speak` izni olmalı; `/ses` ile seviyeyi kontrol et.
- **Yayın açılmıyor:** `.env` içindeki `STREAM_URL` alanına çalışan bir Virgin Radio yayın adresi yazabilirsin; bot önce onu dener.
- **`npm install` sırasında ffmpeg hatası:** İnternet bağlantını kontrol edip `npm install` komutunu tekrar çalıştır.
